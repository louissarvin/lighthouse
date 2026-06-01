/**
 * GET /leaderboard — public, unauthenticated read.
 *
 * Ranks TraderProfiles by one of three verifiable metrics:
 *
 *   - `trades`    → count(Trade) per profile (most active)
 *   - `anchors`   → count(WalrusBlob WHERE owner_address = profile.sui_address)
 *                   per profile. EventIndexer.handleAnchorRecorded persists
 *                   one row per on-chain `audit_anchor::AnchorRecorded`
 *                   event with owner_address set, so this is a real per-user
 *                   count of on-chain audit anchors, NOT a Recommendation
 *                   proxy.
 *   - `notional`  → sum(Trade.notional) per profile, FLOAT_SCALING (1e9)
 *                   so the response converts to DBUSDC human units.
 *
 * INTENTIONALLY OMITTED metrics (per product brief): win rate, PnL, profit.
 * DeepBook settled-fill PnL is not computed server-side because we would have
 * to replay every individual fill from `OrderFilled` events with cost-basis
 * accounting; that is a separate workstream and a misleading number here
 * would be worse than no number.
 *
 * Security:
 *   - Public, no auth. Data shown is already public on-chain (addresses,
 *     trade volume, anchor counts).
 *   - 60/min/IP rate limit so a single scraper can't drown the route.
 *   - Fastify schema validation rejects out-of-bounds `limit` and unknown
 *     `metric` values BEFORE the handler runs (no silent clamp).
 *   - Whitelisted Prisma `select` on the JOIN — no row spreads, no
 *     `$queryRaw`. We use `groupBy` for the aggregation and one batched
 *     `findMany` for the profile rows so the worst case is O(2) round-trips
 *     regardless of `limit`.
 *   - In-memory TTL cache (30s) keyed by `metric|limit` so a refresh storm
 *     during demo day hits Postgres once per 30s per metric/limit pair.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { WALRUS_AGGREGATOR_URL } from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

const ALLOWED_METRICS = ['trades', 'anchors', 'notional'] as const;
type Metric = (typeof ALLOWED_METRICS)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CACHE_TTL_MS = 30 * 1000;

interface LeaderboardEntry {
  rank: number;
  suiAddress: string;
  suinsName: string | null;
  avatarBlobId: string | null;
  avatarUrl: string | null;
  bio: string | null;
  tradesPlaced: number;
  anchorCount: number;
  /// Decimal string (DBUSDC human units, full precision).
  totalNotional: string;
  memberSinceMs: number;
}

interface CachedPayload {
  expires: number;
  data: LeaderboardEntry[];
}

const CACHE = new Map<string, CachedPayload>();

function cacheKey(metric: Metric, limit: number): string {
  return `${metric}|${limit}`;
}

function bigIntDivToDecimalString(value: bigint, scale: bigint): string {
  if (scale <= 0n) throw new Error('scale must be positive');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  const out = fracStr.length === 0 ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${out}` : out;
}

interface ProfileMini {
  id: string;
  sui_address: string;
  suins_name: string | null;
  avatar_blob_id: string | null;
  bio: string | null;
  created_at: Date;
}

async function loadProfiles(profileIds: string[]): Promise<Map<string, ProfileMini>> {
  if (profileIds.length === 0) return new Map();
  const rows = await prismaQuery.traderProfile.findMany({
    where: { id: { in: profileIds }, deleted_at: null },
    select: {
      id: true,
      sui_address: true,
      suins_name: true,
      avatar_blob_id: true,
      bio: true,
      created_at: true,
    },
  });
  const map = new Map<string, ProfileMini>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

/// Per-user trade count + sum, computed by `groupBy`. Single round-trip,
/// index-only on `Trade(trader_profile_id, ...)`.
async function rankByTradeAgg(
  metric: 'trades' | 'notional',
  limit: number,
): Promise<LeaderboardEntry[]> {
  const grouped = await prismaQuery.trade.groupBy({
    by: ['trader_profile_id'],
    where: { deleted_at: null },
    _count: { _all: true },
    _sum: { notional: true },
    orderBy:
      metric === 'trades'
        ? { _count: { trader_profile_id: 'desc' } }
        : { _sum: { notional: 'desc' } },
    take: limit,
  });

  const ids = grouped.map((g) => g.trader_profile_id);
  const profilesById = await loadProfiles(ids);

  // Per-user anchor counts in one round-trip via groupBy on WalrusBlob.
  // The leaderboard only needs anchorCount for the top-N rows so the
  // owner_address IN (...) filter keeps this bounded.
  const ownerAddresses = ids
    .map((id) => profilesById.get(id)?.sui_address)
    .filter((a): a is string => typeof a === 'string');
  const anchorRows =
    ownerAddresses.length === 0
      ? []
      : await prismaQuery.walrusBlob.groupBy({
          by: ['owner_address'],
          where: {
            owner_address: { in: ownerAddresses },
            deleted_at: null,
            tx_digest: { not: null },
          },
          _count: { _all: true },
        });
  const anchorByOwner = new Map<string, number>();
  for (const r of anchorRows) {
    if (r.owner_address) anchorByOwner.set(r.owner_address, r._count._all);
  }

  const entries: LeaderboardEntry[] = [];
  let rank = 0;
  for (const g of grouped) {
    const p = profilesById.get(g.trader_profile_id);
    if (!p) continue; // soft-deleted profile, skip silently
    rank += 1;
    const totalNotionalRaw = g._sum.notional ?? 0n;
    entries.push({
      rank,
      suiAddress: p.sui_address,
      suinsName: p.suins_name,
      avatarBlobId: p.avatar_blob_id,
      avatarUrl: p.avatar_blob_id
        ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${p.avatar_blob_id}`
        : null,
      bio: p.bio,
      tradesPlaced: g._count._all,
      anchorCount: anchorByOwner.get(p.sui_address) ?? 0,
      totalNotional: bigIntDivToDecimalString(totalNotionalRaw, 1_000_000_000n),
      memberSinceMs: p.created_at.getTime(),
    });
  }
  return entries;
}

async function rankByAnchors(limit: number): Promise<LeaderboardEntry[]> {
  // EventIndexer indexes `audit_anchor::AnchorRecorded` into WalrusBlob with
  // owner_address. Group by owner, order by count desc.
  const grouped = await prismaQuery.walrusBlob.groupBy({
    by: ['owner_address'],
    where: {
      deleted_at: null,
      tx_digest: { not: null },
      owner_address: { not: null },
    },
    _count: { _all: true },
    orderBy: { _count: { owner_address: 'desc' } },
    take: limit,
  });
  const addresses = grouped
    .map((g) => g.owner_address)
    .filter((a): a is string => typeof a === 'string');
  if (addresses.length === 0) return [];

  const profiles = await prismaQuery.traderProfile.findMany({
    where: { sui_address: { in: addresses }, deleted_at: null },
    select: {
      id: true,
      sui_address: true,
      suins_name: true,
      avatar_blob_id: true,
      bio: true,
      created_at: true,
    },
  });
  const profileByAddr = new Map(profiles.map((p) => [p.sui_address, p]));

  // Per-user trade aggregates in one batched call.
  const profileIds = profiles.map((p) => p.id);
  const tradeAggs =
    profileIds.length === 0
      ? []
      : await prismaQuery.trade.groupBy({
          by: ['trader_profile_id'],
          where: { trader_profile_id: { in: profileIds }, deleted_at: null },
          _count: { _all: true },
          _sum: { notional: true },
        });
  const tradeByProfile = new Map(tradeAggs.map((t) => [t.trader_profile_id, t]));

  const entries: LeaderboardEntry[] = [];
  let rank = 0;
  for (const g of grouped) {
    if (!g.owner_address) continue;
    const p = profileByAddr.get(g.owner_address);
    if (!p) continue;
    rank += 1;
    const t = tradeByProfile.get(p.id);
    const totalNotionalRaw = t?._sum.notional ?? 0n;
    entries.push({
      rank,
      suiAddress: p.sui_address,
      suinsName: p.suins_name,
      avatarBlobId: p.avatar_blob_id,
      avatarUrl: p.avatar_blob_id
        ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${p.avatar_blob_id}`
        : null,
      bio: p.bio,
      tradesPlaced: t?._count._all ?? 0,
      anchorCount: g._count._all,
      totalNotional: bigIntDivToDecimalString(totalNotionalRaw, 1_000_000_000n),
      memberSinceMs: p.created_at.getTime(),
    });
  }
  return entries;
}

export const leaderboardRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            metric: { type: 'string', enum: [...ALLOWED_METRICS], default: 'trades' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIMIT,
              default: DEFAULT_LIMIT,
            },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { metric, limit } = request.query as { metric: Metric; limit: number };
      if (!ALLOWED_METRICS.includes(metric)) {
        return handleError(reply, 400, 'invalid metric', 'BAD_METRIC');
      }

      const key = cacheKey(metric, limit);
      const cached = CACHE.get(key);
      if (cached && cached.expires > Date.now()) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: { metric, limit, entries: cached.data, cached: true },
        });
      }

      try {
        const entries =
          metric === 'anchors'
            ? await rankByAnchors(limit)
            : await rankByTradeAgg(metric, limit);
        CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, data: entries });
        return reply.code(200).send({
          success: true,
          error: null,
          data: { metric, limit, entries, cached: false },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
