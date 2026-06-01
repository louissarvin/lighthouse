/**
 * Follow routes — copy-trader READ feed.
 *
 * Background (LIGHTHOUSE.md §6.2 + §8.5):
 *   `trader_profile::grant_copy_trader(profile, copier, valid_until_ms)`
 *   records a (copier → valid_until_ms) tuple inside the profile's
 *   embedded allowlist. The copier gains permission to *read* the
 *   leader's encrypted trade slice via SEAL (and, in a future wave, to
 *   mirror those trades through their own BalanceManager).
 *
 *   This route exposes ONLY the read side: the last 50 trades the leader
 *   has placed, as already persisted in our DB by /sponsor/place-limit
 *   and the EventIndexer. There is no mirroring execution.
 *
 *   TODO (out of scope for this wave): a worker that watches the leader's
 *   `TradePlaced` Move events and signs mirror PTBs from the follower's
 *   BalanceManager. That requires the follower to grant a DepositCap or
 *   a permissioned executor to the backend, plus per-follower budget
 *   enforcement. Tracked separately under the "copy-trader execution"
 *   epic in LIGHTHOUSE_PALETTE.md.
 *
 * Security:
 *   - Public read for now. The on-chain `granted_until` table is the
 *     authoritative authorization gate; gating this READ endpoint behind
 *     a devInspect call would double the latency for no real privacy win
 *     (the underlying trades are themselves already public via the
 *     /activity/recent endpoint).
 *   - Per-IP rate limit 30/min (slightly tighter than /activity/recent
 *     because this route can be hit per-leader, multiplying scrape volume).
 *   - Address validation up front, before any Prisma read.
 *   - Whitelisted Prisma `select` — never spread the Trade row to avoid
 *     leaking internal columns like `recommendation_id` or
 *     `client_order_id` that the public feed has no need for.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { WALRUS_AGGREGATOR_URL } from '../config/main-config.ts';
import { handleError, handleNotFoundError, handleServerError } from '../utils/errorHandler.ts';

function isValidSuiAddress(s: string): boolean {
  return /^0x[a-f0-9]{64}$/i.test(s);
}

const FEED_LIMIT = 50;

export const followRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // ─── GET /follow/feed/:address ─────────────────────────────────────────
  app.get(
    '/feed/:address',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { address } = request.params as { address: string };
      if (!address) return handleError(reply, 400, 'missing address', 'MISSING_ADDRESS');
      if (!isValidSuiAddress(address)) {
        return handleError(reply, 400, 'invalid address', 'BAD_ADDRESS');
      }

      try {
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { sui_address: address },
          select: {
            id: true,
            sui_address: true,
            suins_name: true,
            avatar_blob_id: true,
            bio: true,
          },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');

        const trades = await prismaQuery.trade.findMany({
          where: { trader_profile_id: profile.id, deleted_at: null },
          orderBy: { created_at: 'desc' },
          take: FEED_LIMIT,
          select: {
            side: true,
            price: true,
            quantity: true,
            notional: true,
            status: true,
            walrus_blob_id: true,
            tx_digest: true,
            created_at: true,
          },
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            profile: {
              suiAddress: profile.sui_address,
              suinsName: profile.suins_name,
              avatarBlobId: profile.avatar_blob_id,
              avatarUrl: profile.avatar_blob_id
                ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${profile.avatar_blob_id}`
                : null,
              bio: profile.bio,
            },
            trades: trades.map((t) => ({
              side: t.side,
              // BigInt columns → string so JSON.stringify doesn't throw.
              price: t.price.toString(),
              quantity: t.quantity.toString(),
              notional: t.notional.toString(),
              status: t.status,
              walrusBlobId: t.walrus_blob_id,
              txDigest: t.tx_digest,
              createdAt: t.created_at,
            })),
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
