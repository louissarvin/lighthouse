/**
 * POST /predict/onboard
 *   Body: (none — sender derived from auth)
 *   Returns: { digest, bytes } — client signs, then POST /sponsor/execute
 *
 * Creates a shared PredictManager for the authenticated user, sponsored
 * via Enoki. The user signs once, gets a fresh manager, pays zero gas.
 *
 * The PredictManager has no deposit/withdraw/trade caps minted at create
 * time — those are subsequent owner-signed calls. Use this route as the
 * entry point for the v2 Predict feature.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import {
  buildCreatePredictManagerTx,
  buildPredictDepositTx,
  buildPredictMintTx,
  buildPredictRedeemTx,
  buildPredictSupplyTx,
  buildPredictWithdrawTx,
} from '../lib/predict.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { suiRpc } from '../lib/sui.ts';
import { PREDICT_SERVER_URL } from '../config/main-config.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

// ─── /predict/markets cache + stub ─────────────────────────────────────────
//
// Proxy upstream `${PREDICT_SERVER_URL}/markets`. Cached 60s to absorb the
// /predict page polling. When upstream 5xx's (testnet flake), fall back to a
// minimal stub so the page still renders for judges + the UI can be exercised.

interface MarketsCache {
  body: unknown;
  at: number;
  source: 'upstream' | 'stub';
}
let marketsCache: MarketsCache | null = null;
const MARKETS_TTL_MS = 60_000;

const STUB_MARKETS = {
  markets: [
    {
      oracle_id: '0xstub-oracle-sui-usd',
      symbol: 'SUI/USD',
      strike: '5000000000',
      expiry_ms: String(Date.now() + 24 * 60 * 60 * 1000),
      mid_implied_up_bps: 5200,
      mid_implied_down_bps: 4800,
      _note: 'Stub market — upstream predict-server unreachable. Mints would succeed once it is back.',
    },
  ],
  source: 'stub' as const,
};

export const predictRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // ─── GET /predict/markets ─────────────────────────────────────────────
  // Public read-only. Proxy + cache + stub-fallback so the /predict page
  // always renders something. Filtered to markets with future expiry.
  app.get(
    '/markets',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = Date.now();
      if (marketsCache && now - marketsCache.at < MARKETS_TTL_MS) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: marketsCache.body,
          stale: false,
          source: marketsCache.source,
        });
      }

      try {
        const upstream = await fetch(`${PREDICT_SERVER_URL}/markets`, {
          headers: { accept: 'application/json' },
        });
        if (upstream.ok) {
          const j = (await upstream.json()) as Record<string, unknown>;
          const body = { ...j, source: 'upstream' as const };
          marketsCache = { body, at: now, source: 'upstream' };
          return reply.code(200).send({
            success: true,
            error: null,
            data: body,
            stale: false,
            source: 'upstream',
          });
        }
        console.warn(`[predict/markets] upstream ${upstream.status} — serving stub`);
      } catch (e) {
        console.warn(`[predict/markets] upstream failed:`, (e as Error).message);
      }

      // Upstream unreachable — return the stub but mark stale.
      marketsCache = { body: STUB_MARKETS, at: now, source: 'stub' };
      return reply.code(200).send({
        success: true,
        error: null,
        data: STUB_MARKETS,
        stale: true,
        source: 'stub',
      });
    },
  );

  // ─── GET /predict/positions/:managerId ────────────────────────────────
  // Best-effort: proxies upstream if available, otherwise empty array.
  // Kept thin because per-position derivation requires walking the PredictManager
  // tables; for the v1 web UI we just surface what the upstream indexer exposes.
  app.get(
    '/positions/:managerId',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { managerId } = request.params as { managerId: string };
      if (!managerId) {
        return handleError(reply, 400, 'managerId required', 'MANAGER_ID_MISSING');
      }
      try {
        const url = `${PREDICT_SERVER_URL}/positions/${encodeURIComponent(managerId)}`;
        const upstream = await fetch(url, { headers: { accept: 'application/json' } });
        if (upstream.ok) {
          const j = await upstream.json();
          return reply.code(200).send({ success: true, error: null, data: j });
        }
      } catch (e) {
        console.warn(`[predict/positions] upstream failed:`, (e as Error).message);
      }
      // Soft fallback: empty list. The UI renders an empty state.
      return reply.code(200).send({
        success: true,
        error: null,
        data: { positions: [], stale: true, source: 'stub' },
      });
    },
  );

  app.post(
    '/onboard',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address on session', 'NO_SUI_ADDRESS');
      }
      try {
        const tx = buildCreatePredictManagerTx();
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            note: 'Sign these bytes and POST to /sponsor/execute. Creates a shared PredictManager owned by your address.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /predict/deposit ──────────────────────────────────────────────
  // Body: { managerObjectId, coinTypeTag, coinObjectId? }
  //
  // When `coinObjectId` is omitted (or empty), the backend looks up
  // user-owned coins of `coinTypeTag` via JSON-RPC and picks the one with
  // the largest balance. Matches the DepositService.ts coin-selection
  // pattern (getOwnedObjects with StructType filter, then descending sort).
  app.post(
    '/deposit',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as {
        managerObjectId?: string;
        coinObjectId?: string;
        coinTypeTag?: string;
      };
      const missing: string[] = [];
      if (!body.managerObjectId) missing.push('managerObjectId');
      if (!body.coinTypeTag) missing.push('coinTypeTag');
      if (missing.length) return handleValidationError(reply, missing);

      // Resolve coinObjectId: client may pass an explicit id OR ask us to
      // auto-pick the user's largest coin of `coinTypeTag`. We always
      // re-derive ownership from the chain — never trust a client-supplied
      // coin id beyond using it as a hint (Enoki sponsor enforcement still
      // rejects unowned coins, but we fail-fast here for a clean 4xx).
      let coinObjectId = body.coinObjectId;
      if (!coinObjectId || coinObjectId.length === 0) {
        try {
          const ownedRpc = suiRpc as unknown as {
            getOwnedObjects: (args: {
              owner: string;
              filter?: { StructType?: string };
              options?: { showContent?: boolean };
            }) => Promise<{
              data?: Array<{
                data?: {
                  objectId?: string;
                  content?: { fields?: { balance?: string } };
                };
              }>;
            }>;
          };
          const resp = await ownedRpc.getOwnedObjects({
            owner: user.sui_address,
            filter: { StructType: `0x2::coin::Coin<${body.coinTypeTag!}>` },
            options: { showContent: true },
          });
          const candidates = (resp.data ?? [])
            .filter((c) => {
              const bal = c.data?.content?.fields?.balance;
              return !!c.data?.objectId && bal != null && BigInt(bal) > 0n;
            })
            .sort((a, b) => {
              const ba = BigInt(b.data?.content?.fields?.balance ?? '0');
              const aa = BigInt(a.data?.content?.fields?.balance ?? '0');
              return ba > aa ? 1 : ba < aa ? -1 : 0;
            });
          const picked = candidates[0]?.data?.objectId;
          if (!picked) {
            return handleError(
              reply,
              400,
              'No coin of that type found in your wallet',
              'NO_COIN_FOUND',
            );
          }
          coinObjectId = picked;
        } catch (e) {
          return handleError(
            reply,
            502,
            'failed to query owned coins',
            'COIN_LOOKUP_FAILED',
            e as Error,
          );
        }
      }

      try {
        const tx = buildPredictDepositTx({
          managerObjectId: body.managerObjectId!,
          coinObjectId,
          coinTypeTag: body.coinTypeTag!,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            coinObjectId,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /predict/mint ────────────────────────────────────────────────
  // ATOMIC: builds MarketKey + mints prediction + (optional) audit anchor
  // in ONE PTB. Sponsored via Enoki.
  //
  // Body:
  //   { predictObjectId, managerObjectId, oracleObjectId, quoteTypeTag,
  //     oracleId, expiryMs, strike, isUp, quantity,
  //     auditWalrusBlobIdHex? }   // optional: bundles audit anchor
  app.post(
    '/mint',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as {
        predictObjectId?: string;
        managerObjectId?: string;
        oracleObjectId?: string;
        quoteTypeTag?: string;
        oracleId?: string;
        expiryMs?: string;
        strike?: string;
        isUp?: boolean;
        quantity?: string;
        auditWalrusBlobIdHex?: string;
      };
      const missing: string[] = [];
      for (const k of [
        'predictObjectId',
        'managerObjectId',
        'oracleObjectId',
        'quoteTypeTag',
        'oracleId',
        'expiryMs',
        'strike',
        'isUp',
        'quantity',
      ] as const) {
        if (body[k] === undefined || body[k] === null || body[k] === '')
          missing.push(k);
      }
      if (missing.length) return handleValidationError(reply, missing);

      try {
        const auditBytes = body.auditWalrusBlobIdHex
          ? Uint8Array.from(Buffer.from(body.auditWalrusBlobIdHex, 'hex'))
          : undefined;
        const tx = buildPredictMintTx({
          predictObjectId: body.predictObjectId!,
          managerObjectId: body.managerObjectId!,
          oracleObjectId: body.oracleObjectId!,
          quoteTypeTag: body.quoteTypeTag!,
          oracleId: body.oracleId!,
          expiryMs: BigInt(body.expiryMs!),
          strike: BigInt(body.strike!),
          isUp: !!body.isUp,
          quantity: BigInt(body.quantity!),
          auditWalrusBlobIdBytes: auditBytes,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: sponsored.digest, bytes: sponsored.bytes },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /predict/redeem ──────────────────────────────────────────────
  // Same body shape as /mint. Bundles audit anchor if `auditWalrusBlobIdHex`
  // is provided.
  app.post(
    '/redeem',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as {
        predictObjectId?: string;
        managerObjectId?: string;
        oracleObjectId?: string;
        quoteTypeTag?: string;
        oracleId?: string;
        expiryMs?: string;
        strike?: string;
        isUp?: boolean;
        quantity?: string;
        auditWalrusBlobIdHex?: string;
      };
      const missing: string[] = [];
      for (const k of [
        'predictObjectId',
        'managerObjectId',
        'oracleObjectId',
        'quoteTypeTag',
        'oracleId',
        'expiryMs',
        'strike',
        'isUp',
        'quantity',
      ] as const) {
        if (body[k] === undefined || body[k] === null || body[k] === '')
          missing.push(k);
      }
      if (missing.length) return handleValidationError(reply, missing);

      try {
        const auditBytes = body.auditWalrusBlobIdHex
          ? Uint8Array.from(Buffer.from(body.auditWalrusBlobIdHex, 'hex'))
          : undefined;
        const tx = buildPredictRedeemTx({
          predictObjectId: body.predictObjectId!,
          managerObjectId: body.managerObjectId!,
          oracleObjectId: body.oracleObjectId!,
          quoteTypeTag: body.quoteTypeTag!,
          oracleId: body.oracleId!,
          expiryMs: BigInt(body.expiryMs!),
          strike: BigInt(body.strike!),
          isUp: !!body.isUp,
          quantity: BigInt(body.quantity!),
          auditWalrusBlobIdBytes: auditBytes,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: sponsored.digest, bytes: sponsored.bytes },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /predict/supply ──────────────────────────────────────────────
  // Body: { predictObjectId, coinObjectId, quoteTypeTag }
  // Returns Coin<PLP> transferred to sender.
  app.post(
    '/supply',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as {
        predictObjectId?: string;
        coinObjectId?: string;
        quoteTypeTag?: string;
      };
      const missing: string[] = [];
      if (!body.predictObjectId) missing.push('predictObjectId');
      if (!body.coinObjectId) missing.push('coinObjectId');
      if (!body.quoteTypeTag) missing.push('quoteTypeTag');
      if (missing.length) return handleValidationError(reply, missing);

      try {
        const tx = buildPredictSupplyTx({
          predictObjectId: body.predictObjectId!,
          coinObjectId: body.coinObjectId!,
          quoteTypeTag: body.quoteTypeTag!,
          recipient: user.sui_address,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            note: 'After execute: Coin<PLP> LP tokens are transferred to your address. Hold them to claim a pro-rata share of the prediction vault.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /predict/withdraw ────────────────────────────────────────────
  // Body: { predictObjectId, lpCoinObjectId, quoteTypeTag }
  // Burns Coin<PLP>, returns Coin<Quote> to sender.
  app.post(
    '/withdraw',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as {
        predictObjectId?: string;
        lpCoinObjectId?: string;
        quoteTypeTag?: string;
      };
      const missing: string[] = [];
      if (!body.predictObjectId) missing.push('predictObjectId');
      if (!body.lpCoinObjectId) missing.push('lpCoinObjectId');
      if (!body.quoteTypeTag) missing.push('quoteTypeTag');
      if (missing.length) return handleValidationError(reply, missing);

      try {
        const tx = buildPredictWithdrawTx({
          predictObjectId: body.predictObjectId!,
          lpCoinObjectId: body.lpCoinObjectId!,
          quoteTypeTag: body.quoteTypeTag!,
          recipient: user.sui_address,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: sponsored.digest, bytes: sponsored.bytes },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── GET /predict/pnl ──────────────────────────────────────────────────
  // Returns prediction P&L stats for the authenticated trader.
  // Mirrors the Telegram `/pnl` command. All counts come from `hedgePosition`
  // rows scoped to the user's trader_profile_id. Wagered volume is the sum
  // of `quantity` (DUSDC raw, 6 decimals) across all non-deleted positions.
  app.get(
    '/pnl',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      try {
        const traderProfileId = user.trader_profile_id;
        const [won, lost, open, redeemed, wageredResult] = await Promise.all([
          prismaQuery.hedgePosition.count({
            where: { trader_profile_id: traderProfileId, status: 'settled', deleted_at: null },
          }),
          prismaQuery.hedgePosition.count({
            where: { trader_profile_id: traderProfileId, status: 'lost', deleted_at: null },
          }),
          prismaQuery.hedgePosition.count({
            where: { trader_profile_id: traderProfileId, status: 'open', deleted_at: null },
          }),
          prismaQuery.hedgePosition.count({
            where: { trader_profile_id: traderProfileId, status: 'redeemed', deleted_at: null },
          }),
          prismaQuery.hedgePosition.aggregate({
            where: { trader_profile_id: traderProfileId, deleted_at: null },
            _sum: { quantity: true },
          }),
        ]);

        const totalSettled = won + lost;
        const winRate =
          totalSettled > 0 ? Math.round((won / totalSettled) * 100) : null;

        const totalWageredRaw = wageredResult._sum.quantity ?? 0n;
        const totalWageredDusdc = (Number(totalWageredRaw) / 1_000_000).toFixed(2);

        let streak: 'win_streak' | 'loss_streak' | 'positive_run' | 'negative_run' | null;
        if (won > 0 && lost === 0) streak = 'win_streak';
        else if (lost > 0 && won === 0) streak = 'loss_streak';
        else if (won > lost) streak = 'positive_run';
        else if (lost > won) streak = 'negative_run';
        else streak = null;

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            open,
            won,
            lost,
            redeemed,
            winRate,
            totalWageredDusdc,
            streak,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // POST /predict/record-manager
  // Called by the web client after /predict/onboard + /sponsor/execute to
  // persist the newly-created PredictManager's object ID onto the TraderProfile.
  //
  // The backend parses objectChanges from the tx, finds the PredictManager
  // object, and persists it. This mirrors what PredictService.setupPredictViaZkLogin()
  // does in the Telegram flow.
  //
  // Body: { txDigest: string }
  // Response: { predictManagerId: string }
  app.post(
    '/record-manager',
    { preHandler: [authMiddleware], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = (request.body ?? {}) as { txDigest?: string };
      if (!body.txDigest || typeof body.txDigest !== 'string') {
        return handleValidationError(reply, ['txDigest']);
      }

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      // Idempotent: if already recorded, return the existing id.
      if (profile.predict_manager_id) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: { predictManagerId: profile.predict_manager_id, alreadySet: true },
        });
      }

      // Wait for the tx to be indexed and parse objectChanges.
      // Use suiRpc.waitForTransaction (same pattern as PredictService assertTxSuccess).
      type TxBlockShape = {
        objectChanges?: Array<{
          type?: string;
          objectId?: string;
          objectType?: string;
        }>;
      };

      let txInfo: TxBlockShape | null = null;
      try {
        const rpcTx = suiRpc as unknown as {
          waitForTransaction: (params: {
            digest: string;
            options?: { showObjectChanges?: boolean };
            timeout?: number;
            pollInterval?: number;
          }) => Promise<TxBlockShape>;
        };
        txInfo = await rpcTx.waitForTransaction({
          digest: body.txDigest,
          options: { showObjectChanges: true },
          timeout: 30_000,
          pollInterval: 1_000,
        });
      } catch (e) {
        return handleError(
          reply,
          502,
          'tx not indexed yet, retry in a few seconds',
          'TX_NOT_INDEXED',
          e as Error,
        );
      }

      const created = (txInfo?.objectChanges ?? []).filter((c) => c.type === 'created');
      const managerObj = created.find((c) =>
        c.objectType?.includes('::predict_manager::PredictManager'),
      );
      if (!managerObj?.objectId) {
        return handleError(
          reply,
          422,
          'no PredictManager object found in tx objectChanges',
          'MANAGER_NOT_FOUND',
        );
      }

      try {
        await prismaQuery.traderProfile.update({
          where: { id: profile.id },
          data: { predict_manager_id: managerObj.objectId },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }

      return reply.code(200).send({
        success: true,
        error: null,
        data: { predictManagerId: managerObj.objectId, alreadySet: false },
      });
    },
  );

  // ─── GET /predict/positions-own ────────────────────────────────────────
  // Web inbox view that mirrors the Telegram /positions buckets.
  //
  // HedgePosition.status values (per src/workers/predictSettlementWorker.ts):
  //   'open'      — minted, market not yet settled.
  //   'settled'   — settled and WON; DUSDC claim available (the "claimable"
  //                 bucket the web shows a Redeem button for).
  //   'lost'      — settled and LOST; no claim.
  //   'redeemed'  — won and redeem_permissionless already executed.
  //
  // Returns: { open, claimable, lost, redeemed, summary }
  app.get(
    '/positions-own',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      try {
        const rows = await prismaQuery.hedgePosition.findMany({
          where: {
            trader_profile_id: user.trader_profile_id,
            deleted_at: null,
          },
          orderBy: { created_at: 'desc' },
        });

        const open: typeof rows = [];
        const claimable: typeof rows = [];
        const lost: typeof rows = [];
        const redeemed: typeof rows = [];
        for (const r of rows) {
          if (r.status === 'open') open.push(r);
          else if (r.status === 'settled') claimable.push(r);
          else if (r.status === 'lost') lost.push(r);
          else if (r.status === 'redeemed') redeemed.push(r);
        }

        const serialize = (r: (typeof rows)[number]): Record<string, unknown> => ({
          id: r.id,
          oracleId: r.oracle_id,
          predictId: r.predict_id,
          strike: r.strike.toString(),
          isUp: r.is_up,
          quantity: r.quantity.toString(),
          cost: r.cost.toString(),
          status: r.status,
          payout: r.payout?.toString() ?? null,
          txDigest: r.tx_digest,
          settledAt: r.settled_at?.toISOString() ?? null,
          expiryMs: r.expiry_ms?.toString() ?? null,
          createdAt: r.created_at.toISOString(),
        });

        const totalOpenRaw = open.reduce((acc, r) => acc + r.quantity, 0n);
        // Claimable payout: prefer `payout` when present, else fall back to
        // `quantity` as a conservative lower bound (binary option pays 1:1
        // on the wagered notional).
        const totalClaimableRaw = claimable.reduce(
          (acc, r) => acc + (r.payout ?? r.quantity),
          0n,
        );

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            open: open.map(serialize),
            claimable: claimable.map(serialize),
            lost: lost.map(serialize),
            redeemed: redeemed.map(serialize),
            summary: {
              totalOpen: open.length,
              totalClaimable: claimable.length,
              totalLost: lost.length,
              totalRedeemed: redeemed.length,
              totalOpenDusdc: (Number(totalOpenRaw) / 1_000_000).toFixed(2),
              totalClaimableDusdc: (Number(totalClaimableRaw) / 1_000_000).toFixed(2),
            },
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
