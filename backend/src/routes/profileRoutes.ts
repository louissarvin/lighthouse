/**
 * Profile sync routes.
 *
 * The on-chain TraderProfile + BalanceManager + ExecutorAgent are minted by
 * the user (their wallet/Enoki signature). After each PTB succeeds the
 * frontend posts the resulting object ID(s) here so the backend can wire
 * notifications + indexer + coach state.
 *
 * Routes:
 *   POST /profile/record-trader-profile-id
 *   POST /profile/record-balance-manager-id
 *   POST /profile/record-executor-agent-id
 *
 * All require authMiddleware so only the authenticated user can write.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { envelopeDecrypt } from '../lib/envelope.ts';
import { buildMemoryWriteWithProofTx } from '../lib/lighthouseTxs.ts';
import { NAMESPACES, recall } from '../lib/memwal.ts';
import { resolveSuiNS } from '../lib/suins.ts';
import { WALRUS_AGGREGATOR_URL } from '../config/main-config.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface RecordIdBody {
  objectId?: string;
}

// Negative-cache for the legacy-user risk-profile backfill in GET /profile/me.
// Avoids hammering MemWal for users who never completed setup. Cleared after
// 5 minutes so a freshly-completed Telegram /setup propagates within the TTL.
const RISK_BACKFILL_NEG_CACHE = new Map<string, number>();
const RISK_BACKFILL_NEG_TTL_MS = 5 * 60 * 1000;
const RISK_BACKFILL_RECALL_TIMEOUT_MS = 3000;

function backfillMissed(profileId: string): boolean {
  const ts = RISK_BACKFILL_NEG_CACHE.get(profileId);
  if (ts === undefined) return false;
  if (Date.now() - ts > RISK_BACKFILL_NEG_TTL_MS) {
    RISK_BACKFILL_NEG_CACHE.delete(profileId);
    return false;
  }
  return true;
}

interface UpdateBlobBody {
  /// Slice tag (e.g. "trades", "risk-profile", "pnl:summary").
  slice?: string;
  /// Walrus blob ID hex (32 bytes, from `blobIdToInt` u256 BCS encoding).
  blobIdHex?: string;
}

export const profileRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post(
    '/record-trader-profile-id',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RecordIdBody;
      if (!body?.objectId) return handleValidationError(reply, ['objectId']);
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      try {
        const updated = await prismaQuery.traderProfile.update({
          where: { sui_address: user.sui_address },
          data: { profile_object_id: body.objectId },
        });
        return reply.code(200).send({ success: true, error: null, data: { id: updated.id } });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/record-balance-manager-id',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RecordIdBody;
      if (!body?.objectId) return handleValidationError(reply, ['objectId']);
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      try {
        const updated = await prismaQuery.traderProfile.update({
          where: { sui_address: user.sui_address },
          data: { balance_manager_id: body.objectId },
        });
        return reply.code(200).send({ success: true, error: null, data: { id: updated.id } });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/record-executor-agent-id',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RecordIdBody;
      if (!body?.objectId) return handleValidationError(reply, ['objectId']);
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      try {
        const updated = await prismaQuery.traderProfile.update({
          where: { sui_address: user.sui_address },
          data: { executor_agent_id: body.objectId },
        });
        return reply.code(200).send({ success: true, error: null, data: { id: updated.id } });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === Sponsored update_blob — frontend calls after archiveBlob returns ===
  app.post(
    '/update-blob',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as UpdateBlobBody;
      const missing: string[] = [];
      if (!body?.slice) missing.push('slice');
      if (!body?.blobIdHex) missing.push('blobIdHex');
      if (missing.length) return handleValidationError(reply, missing);
      if (!/^[0-9a-fA-F]+$/.test(body.blobIdHex!) || body.blobIdHex!.length % 2 !== 0) {
        return handleError(reply, 400, 'blobIdHex must be even-length hex', 'BAD_HEX');
      }

      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');

      try {
        // ATOMIC: update_blob + audit_anchor::record + transfer_to_owner in
        // ONE PTB. Every profile write leaves a verifiable on-chain receipt
        // referencing the Walrus blob id. Backend cannot serve a write
        // without the anchor — they're inseparable.
        const blobIdBytes = Uint8Array.from(Buffer.from(body.blobIdHex!, 'hex'));
        const tx = buildMemoryWriteWithProofTx({
          profileObjectId: profile.profile_object_id,
          slice: body.slice!,
          blobIdBytes,
          kind: 0, // recommendation
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

  // ─── GET /profile/by-suins/:name ────────────────────────────────────────
  // Public, unauthenticated read for shareable `/u/<name>` pages.
  //
  // Resolves a SuiNS apex to a TraderProfile and returns a public summary:
  //   - confirmed sui_address + suins_name binding
  //   - profile / executor / balance-manager IDs (already public on-chain)
  //   - aggregate counts (trades placed, audit anchors recorded)
  //   - latest WeeklyTearsheet summary (if any)
  //   - recent on-chain activity (last 8 events)
  //
  // Excluded by design: Telegram identifiers, JWTs, MemWal account id (it
  // is technically public on-chain but the explorer link already covers
  // that and we don't want one-stop scraping of bot users), encrypted
  // delegate key, copy_trader_granted_until row contents.
  app.get(
    '/by-suins/:name',
    {
      // Public-but-rate-limited: SuiNS resolution + DB lookups should
      // tolerate a refresh storm during demo day without DoS'ing.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      if (!name) return handleError(reply, 400, 'missing name', 'MISSING_PARAM');
      try {
        const address = await resolveSuiNS(name);
        if (!address) return handleNotFoundError(reply, `SuiNS name "${name}"`);
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { sui_address: address },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');

        // Parallel aggregates + latest tearsheet metadata. Counts are scoped
        // to the resolved trader profile so unrelated address activity does
        // not leak into the public profile.
        const [tradesCount, anchorsCount, latestTearsheet] = await Promise.all(
          [
            prismaQuery.trade.count({
              where: { trader_profile_id: profile.id, deleted_at: null },
            }),
            prismaQuery.walrusBlob.count({
              where: {
                deleted_at: null,
                tx_digest: { not: null },
                // WalrusBlob is global (no trader_profile_id column) — we
                // intentionally surface the protocol-wide count here so the
                // public profile shows the Lighthouse heartbeat, not a
                // misleading per-user value. The frontend label reflects
                // this with "anchors recorded by Lighthouse".
              },
            }),
            prismaQuery.weeklyTearsheet.findFirst({
              where: { trader_profile_id: profile.id, deleted_at: null },
              orderBy: { window_to: 'desc' },
              select: {
                week: true,
                quilt_blob_id: true,
                tearsheet_identifier: true,
                audit_anchor_tx: true,
                window_from: true,
                window_to: true,
                total_trades: true,
              },
            }),
          ],
        );

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            suinsName: profile.suins_name ?? name,
            suiAddress: address,
            profileObjectId: profile.profile_object_id,
            balanceManagerId: profile.balance_manager_id,
            executorAgentId: profile.executor_agent_id,
            // walrus_site_id lives on the user's SuiNSRegistration NFT
            // metadata, not in our DB. The frontend can resolve it via
            // an explorer query against the NFT if needed; we don't
            // proxy that read here to keep this endpoint DB-only.
            walrusSiteObjectId: null,
            createdAt: profile.created_at,
            counts: {
              tradesPlaced: tradesCount,
              lighthouseAnchorsTotal: anchorsCount,
            },
            latestTearsheet: latestTearsheet
              ? {
                  week: latestTearsheet.week,
                  walrusBlobId: latestTearsheet.quilt_blob_id,
                  auditAnchorTxDigest: latestTearsheet.audit_anchor_tx,
                  windowFrom: latestTearsheet.window_from,
                  windowTo: latestTearsheet.window_to,
                  totalTrades: latestTearsheet.total_trades,
                  publicTearsheetUrl: `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${latestTearsheet.quilt_blob_id}/${latestTearsheet.tearsheet_identifier}`,
                }
              : null,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.get(
    '/me',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { sui_address: user.sui_address },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      // Lazy backfill for legacy users: if the column is NULL but the user
      // has a MemWal account, probe for the bot's "Full onboarding profile
      // completed" anchor entry. Bounded by a 3s timeout and a 5-minute
      // negative cache so a non-completer never pays this cost twice.
      let riskCompletedAt: Date | null = profile.risk_profile_completed_at;
      if (
        !riskCompletedAt &&
        profile.memwal_account_id &&
        profile.memwal_delegate_key_encrypted &&
        !backfillMissed(profile.id)
      ) {
        try {
          const delegateKey = envelopeDecrypt(
            profile.id,
            profile.memwal_delegate_key_encrypted,
          );
          const account = {
            delegateKey,
            accountId: profile.memwal_account_id,
          };
          const recallPromise = recall(
            account,
            'Full onboarding profile completed',
            NAMESPACES.riskProfile,
            1,
          );
          const timeoutPromise = new Promise<never>((_, rej) =>
            setTimeout(
              () => rej(new Error('backfill recall timeout')),
              RISK_BACKFILL_RECALL_TIMEOUT_MS,
            ),
          );
          const hits = await Promise.race([recallPromise, timeoutPromise]);
          if (Array.isArray(hits) && hits.length > 0) {
            const now = new Date();
            await prismaQuery.traderProfile.update({
              where: { id: profile.id },
              data: { risk_profile_completed_at: now },
            });
            riskCompletedAt = now;
            RISK_BACKFILL_NEG_CACHE.delete(profile.id);
          } else {
            RISK_BACKFILL_NEG_CACHE.set(profile.id, Date.now());
          }
        } catch (e) {
          // Never let backfill break /me; cache negative result.
          console.warn(
            '[profile/me] risk-profile backfill skipped:',
            (e as Error).message,
          );
          RISK_BACKFILL_NEG_CACHE.set(profile.id, Date.now());
        }
      }

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          traderProfileId: profile.id,
          suiAddress: profile.sui_address,
          profileObjectId: profile.profile_object_id,
          balanceManagerId: profile.balance_manager_id,
          executorAgentId: profile.executor_agent_id,
          predictManagerId: profile.predict_manager_id,
          depositCapId: profile.deposit_cap_id,
          memwalAccountId: profile.memwal_account_id,
          suinsName: profile.suins_name,
          coachGroupUuid: profile.coach_group_uuid,
          auditGroupUuid: profile.audit_group_uuid,
          version: profile.version,
          createdAt: profile.created_at,
          riskProfileCompletedAt: riskCompletedAt?.toISOString() ?? null,
        },
      });
    },
  );

  // GET /profile/trades
  //
  // Returns the authenticated user's recent trades (most recent first),
  // scoped to their TraderProfile and excluding soft-deleted rows. BigInt
  // columns (price/quantity/notional) are stringified to keep the JSON
  // payload lossless; createdAt is returned as Unix epoch ms.
  app.get(
    '/trades',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }

      const query = (request.query ?? {}) as { limit?: string | number };
      let limit = 20;
      if (query.limit !== undefined) {
        const parsed = Number(query.limit);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
          return handleError(reply, 400, 'limit must be an integer', 'BAD_LIMIT');
        }
        if (parsed < 1 || parsed > 50) {
          return handleError(
            reply,
            400,
            'limit must be between 1 and 50',
            'BAD_LIMIT',
          );
        }
        limit = parsed;
      }

      try {
        const rows = await prismaQuery.trade.findMany({
          where: {
            trader_profile_id: user.trader_profile_id,
            deleted_at: null,
          },
          orderBy: { created_at: 'desc' },
          take: limit,
          select: {
            id: true,
            pool_id: true,
            side: true,
            price: true,
            quantity: true,
            notional: true,
            status: true,
            tx_digest: true,
            created_at: true,
            order_id: true,
          },
        });

        const trades = rows.map((r) => ({
          id: r.id,
          poolId: r.pool_id,
          side: r.side,
          price: r.price.toString(),
          quantity: r.quantity.toString(),
          notional: r.notional.toString(),
          status: r.status,
          txDigest: r.tx_digest,
          orderId: r.order_id,
          createdAt: r.created_at.getTime(),
        }));

        return reply.code(200).send({
          success: true,
          error: null,
          data: { trades },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
