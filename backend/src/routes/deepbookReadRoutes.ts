/**
 * Public read-only DeepBook routes — used by the web /trade page.
 *
 *   GET /deepbook/book/:poolKey?levels=10
 *     -> { bids: [{ price, quantity, total }], asks: [...], mid, lastUpdated }
 *
 *   GET /deepbook/pools
 *     -> static list of supported pool keys.
 *
 * Prices are returned as PLAIN HUMAN DECIMALS (string) because the web UI
 * doesn't care about Move-side FLOAT_SCALING. The internal Guardian + executor
 * paths in `deepbookQueries.ts` keep the scaled BigInt form.
 *
 * Cached for 1.5s in-memory to absorb the /trade pane's 1s polling interval
 * without hammering the DeepBook indexer. Reading these from the SDK is cheap
 * (devInspectTransactionBlock) but a tight loop across many open browser tabs
 * still adds up.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { DeepBookClient } from '@mysten/deepbook-v3';

import { SUI_NETWORK } from '../config/main-config.ts';
import { getCoachAddress } from '../lib/keypairs.ts';
import { suiGrpc } from '../lib/sui.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

// ─── Pool registry ──────────────────────────────────────────────────────────
//
// Mirrors `memory/LIGHTHOUSE_BACKEND_TESTNET_CONSTANTS.md` §10 (executor
// allowlist) and the DeepBook SDK testnet pool registry. We expose ONLY the
// three pools that the ExecutorAgent's `allowed_pools` whitelists by default,
// so the order book pane and the /trade form share the same universe of pools.
//
// `baseScalar` and `quoteScalar` map the SDK's already-human-decimal output
// back to raw integer units when the UI needs them.

type SupportedPoolKey = 'SUI_DBUSDC' | 'DEEP_SUI' | 'WAL_SUI';

interface PoolMeta {
  address: string;
  base: { key: string; type: string; scalar: number; symbol: string; decimals: number };
  quote: { key: string; type: string; scalar: number; symbol: string; decimals: number };
}

const SUI_TYPE = '0x2::sui::SUI';
const DBUSDC_TYPE = process.env.DEEPBOOK_DBUSDC_TYPE
  ?? '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const DEEP_TYPE = process.env.DEEPBOOK_DEEP_TYPE
  ?? '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
const WAL_TYPE = process.env.DEEPBOOK_WAL_TYPE
  ?? '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76::wal::WAL';

const SUI = { key: 'SUI', type: SUI_TYPE, scalar: 1_000_000_000, symbol: 'SUI', decimals: 9 };
const DBUSDC = { key: 'DBUSDC', type: DBUSDC_TYPE, scalar: 1_000_000, symbol: 'DBUSDC', decimals: 6 };
const DEEP = { key: 'DEEP', type: DEEP_TYPE, scalar: 1_000_000, symbol: 'DEEP', decimals: 6 };
const WAL = { key: 'WAL', type: WAL_TYPE, scalar: 1_000_000_000, symbol: 'WAL', decimals: 9 };

const POOLS: Record<SupportedPoolKey, PoolMeta> = {
  SUI_DBUSDC: {
    address: process.env.DEEPBOOK_SUI_DBUSDC_POOL
      ?? '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',
    base: SUI,
    quote: DBUSDC,
  },
  DEEP_SUI: {
    address: process.env.DEEPBOOK_DEEP_SUI_POOL
      ?? '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
    base: DEEP,
    quote: SUI,
  },
  WAL_SUI: {
    address: process.env.DEEPBOOK_WAL_SUI_POOL
      ?? '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a',
    base: WAL,
    quote: SUI,
  },
};

// ─── DeepBookClient cache per pool ──────────────────────────────────────────
//
// The SDK keys pools by friendly string key, not raw object id. Spinning up a
// client per pool is the cheapest way to keep all pools queryable through the
// same SDK API surface.
const clientCache = new Map<SupportedPoolKey, DeepBookClient>();

function getClient(poolKey: SupportedPoolKey): DeepBookClient {
  const cached = clientCache.get(poolKey);
  if (cached) return cached;
  const pool = POOLS[poolKey];
  const client = new DeepBookClient({
    client: suiGrpc as never,
    address: getCoachAddress(),
    network: (SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet',
    balanceManagers: {},
    coins: {
      [pool.base.key]: {
        address: pool.base.type.split('::')[0]!,
        type: pool.base.type,
        scalar: pool.base.scalar,
      },
      [pool.quote.key]: {
        address: pool.quote.type.split('::')[0]!,
        type: pool.quote.type,
        scalar: pool.quote.scalar,
      },
    },
    pools: {
      [poolKey]: {
        address: pool.address,
        baseCoin: pool.base.key,
        quoteCoin: pool.quote.key,
      },
    },
  });
  clientCache.set(poolKey, client);
  return client;
}

// ─── In-memory cache for /book responses ────────────────────────────────────
interface CacheEntry {
  body: unknown;
  at: number;
}
const BOOK_CACHE_TTL_MS = 1500;
const bookCache = new Map<string, CacheEntry>();

function getBookCache(key: string): unknown | null {
  const e = bookCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > BOOK_CACHE_TTL_MS) {
    bookCache.delete(key);
    return null;
  }
  return e.body;
}

function setBookCache(key: string, body: unknown): void {
  bookCache.set(key, { body, at: Date.now() });
}

// ─── Routes ────────────────────────────────────────────────────────────────

interface LevelRow {
  /// Human-decimal price as a string for stable JSON transport.
  price: string;
  /// Human-decimal base quantity.
  quantity: string;
  /// Cumulative human-decimal notional (price * sum(qty up to this level)).
  total: string;
}

interface BookSnapshot {
  poolKey: SupportedPoolKey;
  poolId: string;
  base: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  mid: string | null;
  bids: LevelRow[];
  asks: LevelRow[];
  lastUpdated: number;
}

function isSupportedPoolKey(s: string): s is SupportedPoolKey {
  return s === 'SUI_DBUSDC' || s === 'DEEP_SUI' || s === 'WAL_SUI';
}

export const deepbookReadRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // GET /deepbook/pools — surface for the /trade pool picker.
  app.get('/pools', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({
      success: true,
      error: null,
      data: Object.entries(POOLS).map(([key, meta]) => ({
        poolKey: key,
        poolId: meta.address,
        base: meta.base.symbol,
        quote: meta.quote.symbol,
        baseType: meta.base.type,
        quoteType: meta.quote.type,
        baseDecimals: meta.base.decimals,
        quoteDecimals: meta.quote.decimals,
      })),
    });
  });

  // GET /deepbook/book/:poolKey
  app.get(
    '/book/:poolKey',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { poolKey?: string };
      const query = (request.query ?? {}) as { levels?: string };
      const poolKey = (params.poolKey ?? '').toUpperCase();
      if (!isSupportedPoolKey(poolKey)) {
        return handleError(reply, 400, `unsupported poolKey: ${params.poolKey}`, 'POOL_KEY_INVALID');
      }
      const levels = Math.max(1, Math.min(50, Number(query.levels) || 10));
      const cacheKey = `${poolKey}:${levels}`;

      const cached = getBookCache(cacheKey);
      if (cached) {
        return reply.code(200).send({ success: true, error: null, data: cached });
      }

      try {
        const meta = POOLS[poolKey];
        const client = getClient(poolKey);
        const sdk = client as unknown as {
          midPrice: (poolKey: string) => Promise<number>;
          getLevel2TicksFromMid?: (
            poolKey: string,
            n: number,
          ) => Promise<{
            bid_prices: number[];
            bid_quantities: number[];
            ask_prices: number[];
            ask_quantities: number[];
          }>;
        };

        const [midResult, l2Result] = await Promise.allSettled([
          sdk.midPrice(poolKey),
          typeof sdk.getLevel2TicksFromMid === 'function'
            ? sdk.getLevel2TicksFromMid(poolKey, levels)
            : Promise.resolve(null),
        ]);

        const mid =
          midResult.status === 'fulfilled' && Number.isFinite(midResult.value)
            ? midResult.value
            : null;

        let bidsRows: LevelRow[] = [];
        let asksRows: LevelRow[] = [];
        if (l2Result.status === 'fulfilled' && l2Result.value) {
          const l2 = l2Result.value;
          let bidCum = 0;
          bidsRows = l2.bid_prices.map((p, i) => {
            const q = l2.bid_quantities[i] ?? 0;
            bidCum += p * q;
            return {
              price: p.toString(),
              quantity: q.toString(),
              total: bidCum.toString(),
            };
          });
          let askCum = 0;
          asksRows = l2.ask_prices.map((p, i) => {
            const q = l2.ask_quantities[i] ?? 0;
            askCum += p * q;
            return {
              price: p.toString(),
              quantity: q.toString(),
              total: askCum.toString(),
            };
          });
        }

        const body: BookSnapshot = {
          poolKey,
          poolId: meta.address,
          base: meta.base.symbol,
          quote: meta.quote.symbol,
          baseDecimals: meta.base.decimals,
          quoteDecimals: meta.quote.decimals,
          mid: mid !== null ? mid.toString() : null,
          bids: bidsRows,
          asks: asksRows,
          lastUpdated: Date.now(),
        };
        setBookCache(cacheKey, body);

        return reply.code(200).send({ success: true, error: null, data: body });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
