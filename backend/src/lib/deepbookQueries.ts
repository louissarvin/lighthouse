/**
 * DeepBook v3 read-only queries.
 *
 * Source: `@mysten/deepbook-v3@1.4.1` `client.d.mts:84-198`. All methods
 * verified in this file are read-only — they internally call
 * `devInspectTransactionBlock` under the hood.
 *
 * The DeepBook SDK keys pools and balance-managers by FRIENDLY KEY (string
 * label), not raw object ID. We register one of each at construction so the
 * read calls work cleanly. Keys are arbitrary.
 *
 * Used by:
 *   - GuardianLayer market context (mid_price)
 *   - Telegram `/balance` command
 *   - Future: orderbook depth for slippage estimation
 */

import { DeepBookClient } from '@mysten/deepbook-v3';

import {
  DEEPBOOK_DBUSDC_TYPE,
  DEEPBOOK_SUI_DBUSDC_POOL,
  SUI_NETWORK,
} from '../config/main-config.ts';
import { getCoachAddress } from './keypairs.ts';
import { suiGrpc } from './sui.ts';

// === Static registration: SUI + DBUSDC + the SUI_DBUSDC pool ===

const COIN_SUI_KEY = 'SUI';
const COIN_DBUSDC_KEY = 'DBUSDC';
const POOL_SUI_DBUSDC_KEY = 'SUI_DBUSDC';
const BM_KEY = 'user_bm';

/**
 * Construct a DeepBookClient bound to one user's BalanceManager. Cached
 * per-balance-manager because the SDK holds it in the constructor.
 */
const cache = new Map<string, DeepBookClient>();

interface BuildArgs {
  balanceManagerId: string;
  tradeCapId?: string;
}

function buildClient(args: BuildArgs): DeepBookClient {
  const cached = cache.get(args.balanceManagerId);
  if (cached) return cached;

  const client = new DeepBookClient({
    // DeepBookClient accepts the gRPC client; cast for SDK signature compat.
    client: suiGrpc as never,
    address: getCoachAddress(),
    network: (SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet',
    balanceManagers: {
      [BM_KEY]: {
        address: args.balanceManagerId,
        tradeCap: args.tradeCapId,
      },
    },
    coins: {
      [COIN_SUI_KEY]: {
        address: '0x2',
        type: '0x2::sui::SUI',
        scalar: 1_000_000_000, // 9 decimals
      },
      [COIN_DBUSDC_KEY]: {
        // The package address portion is extracted from the full type tag.
        address: DEEPBOOK_DBUSDC_TYPE ? DEEPBOOK_DBUSDC_TYPE.split('::')[0]! : '',
        type: DEEPBOOK_DBUSDC_TYPE,
        scalar: 1_000_000, // 6 decimals
      },
    },
    pools: {
      [POOL_SUI_DBUSDC_KEY]: {
        address: DEEPBOOK_SUI_DBUSDC_POOL,
        baseCoin: COIN_SUI_KEY,
        quoteCoin: COIN_DBUSDC_KEY,
      },
    },
  });
  cache.set(args.balanceManagerId, client);
  return client;
}

// === Read methods ===

export interface LhManagerBalance {
  /// Human-friendly coin label (e.g. `'SUI'`, `'DBUSDC'`).
  coin: string;
  /// Raw units (BigInt-stringified for transport).
  balance: string;
}

/**
 * Query a single coin balance from the user's BalanceManager.
 *
 * @param balanceManagerId  On-chain BM object ID.
 * @param coinKey           One of `'SUI'` or `'DBUSDC'`.
 */
export async function getManagerBalance(
  balanceManagerId: string,
  coinKey: 'SUI' | 'DBUSDC',
): Promise<LhManagerBalance> {
  const dbClient = buildClient({ balanceManagerId });
  // SDK returns `{ coinType: string; balance: number }`.
  const raw = await dbClient.checkManagerBalance(BM_KEY, coinKey);
  return { coin: coinKey, balance: raw.balance.toString() };
}

/**
 * Get the SUI_DBUSDC mid price (FLOAT_SCALING'd). The SDK returns a plain
 * number that's already scaled by the SDK's float-scaling.
 */
export async function getSuiDbusdcMidPrice(): Promise<bigint> {
  // Pass any BM id we have on hand — midPrice does not use it. Use a sentinel.
  const dbClient = buildClient({ balanceManagerId: '0x0' });
  const mid = await dbClient.midPrice(POOL_SUI_DBUSDC_KEY);
  // Convert the float (already scaled) into the BigInt FLOAT_SCALING'd form
  // our Guardian expects. The DeepBook SDK returns mid in human units of
  // quote-per-base, so we multiply by 1e9 to match Move-side FLOAT_SCALING.
  if (typeof mid !== 'number' || !Number.isFinite(mid)) {
    return 0n;
  }
  return BigInt(Math.floor(mid * 1_000_000_000));
}

/**
 * Get top-N orderbook ticks around the mid price (per `getLevel2TicksFromMid`).
 * Used by Guardian for depth-aware slippage estimation.
 *
 * Returns:
 *   { bids: [{ price, quantity }, ...], asks: [{ price, quantity }, ...] }
 * Prices are FLOAT_SCALING'd, quantities are base raw units.
 */
export interface OrderbookSnapshot {
  bids: { price: bigint; quantity: bigint }[];
  asks: { price: bigint; quantity: bigint }[];
}

export async function getSuiDbusdcOrderbook(ticks = 10): Promise<OrderbookSnapshot> {
  const dbClient = buildClient({ balanceManagerId: '0x0' });
  // SDK return shape (verified `@mysten/deepbook-v3@1.4.1/dist/types/index.d.mts:279-284`):
  //   { bid_prices, bid_quantities, ask_prices, ask_quantities } — snake_case, all `number[]`.
  // SDK already does the FLOAT_SCALING + decimals reduction in
  // `orderQueries.mjs:121-149` so values are HUMAN DECIMALS:
  //   - prices: quote-per-base (e.g. USDC per SUI)
  //   - quantities: human base units (e.g. SUI, not MIST)
  // We re-scale prices to FLOAT_SCALING'd quote (* 1e9) to match Move-side
  // budget unit, and quantities to base raw units (* 1e9 for SUI 9-dp).
  const sdk = dbClient as unknown as {
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
  if (typeof sdk.getLevel2TicksFromMid !== 'function') {
    return { bids: [], asks: [] };
  }
  const raw = await sdk.getLevel2TicksFromMid(POOL_SUI_DBUSDC_KEY, ticks);
  const toScaledPrice = (n: number): bigint => BigInt(Math.floor(n * 1_000_000_000));
  // For SUI base (9 decimals), human qty * 1e9 = raw base units.
  const toBaseRaw = (n: number): bigint => BigInt(Math.floor(n * 1_000_000_000));
  return {
    bids: raw.bid_prices.map((p, i) => ({
      price: toScaledPrice(p),
      quantity: toBaseRaw(raw.bid_quantities[i] ?? 0),
    })),
    asks: raw.ask_prices.map((p, i) => ({
      price: toScaledPrice(p),
      quantity: toBaseRaw(raw.ask_quantities[i] ?? 0),
    })),
  };
}

/**
 * Get all balances we care about for the user. Best-effort: if any single
 * query throws we still return whatever the others gave us.
 */
export async function getAllManagerBalances(
  balanceManagerId: string,
): Promise<LhManagerBalance[]> {
  const results: LhManagerBalance[] = [];
  for (const coin of ['SUI', 'DBUSDC'] as const) {
    try {
      results.push(await getManagerBalance(balanceManagerId, coin));
    } catch (e) {
      console.warn(`[deepbookQueries] ${coin} balance fetch failed:`, (e as Error).message);
    }
  }
  return results;
}
