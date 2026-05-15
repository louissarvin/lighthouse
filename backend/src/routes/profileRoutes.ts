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

/// Allowed avatar MIME types. SVG INTENTIONALLY EXCLUDED — the Walrus
/// aggregator returns `application/octet-stream` for every blob, so a raw
/// SVG would happily render as XSS if the frontend trusted the response
/// content. PNG/JPEG/WebP have no script-execution surface in an <img> tag.
const AVATAR_ALLOWED_MIME = new Set<string>(['image/png', 'image/jpeg', 'image/webp']);
/// Walrus blob ids are URL-safe base64 of a 32-byte hash, ~43 chars. We
/// accept a slightly wider window (32-64) to tolerate aggregator encoding
/// drift but reject obviously malformed inputs.
const BLOB_ID_MIN = 32;
const BLOB_ID_MAX = 64;
const BLOB_ID_RE = /^[A-Za-z0-9_-]+$/;
const BIO_MAX = 280;

interface AvatarBody {
  blobId?: string;
  mimeType?: string;
}

interface BioBody {
  bio?: string;
}

/// Lightweight TTL cache for the by-suins enrichment payload. Invalidated
/// in-process when /profile/me/avatar or /profile/me/bio mutates the user's
/// row so the public page reflects the change within one request.
const BY_SUINS_CACHE = new Map<string, { value: unknown; expires: number }>();
const BY_SUINS_TTL_MS = 30 * 1000;

function bySuinsCacheKey(name: string): string {
  return `by-suins:${name.toLowerCase()}`;
}

function invalidateBySuinsCache(name?: string | null): void {
  if (!name) return;
  BY_SUINS_CACHE.delete(bySuinsCacheKey(name));
}

/// BigInt division producing a fixed-precision decimal string. Used to render
/// FLOAT_SCALING'd notionals (1e9 scale) as human DBUSDC. Pure integer math
/// keeps full precision — never go through `Number` for money values.
function bigIntDivToDecimalString(value: bigint, scale: bigint): string {
  if (scale <= 0n) throw new Error('scale must be positive');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const frac = abs % scale;
  // 9-digit fractional component for 1e9 scale; trim trailing zeros for
  // display compactness while still being exact.
  const fracStr = frac.toString().padStart(scale.toString().length - 1, '0').replace(/0+$/, '');
  const out = fracStr.length === 0 ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${out}` : out;
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

  // ─── Shared enrichment helper for public profile reads ─────────────────
  //
  // Computes the canonical public profile payload for an already-fetched
  // TraderProfile row. Used by /profile/by-suins/:name and
  // /profile/by-address/:address so both surfaces stay byte-identical
  // and an additional metric never gets added in one place but not the
  // other. PnL / win-rate INTENTIONALLY OMITTED per product brief: the
  // executor wrapper records `executor::TradeExecuted` but DeepBook-side
  // settled-fill PnL is not derivable without a full fill-by-fill replay.
  async function enrichProfile(profile: {
    id: string;
    sui_address: string;
    suins_name: string | null;
    profile_object_id: string | null;
    balance_manager_id: string | null;
    executor_agent_id: string | null;
    avatar_blob_id: string | null;
    bio: string | null;
    created_at: Date;
  }) {
    const [
      tradesCount,
      anchorsCount,
      notionalAgg,
      latestTearsheet,
      recentTrades,
    ] = await Promise.all([
      prismaQuery.trade.count({
        where: { trader_profile_id: profile.id, deleted_at: null },
      }),
      // AnchorRecorded events are indexed by EventIndexer.handleAnchorRecorded
      // into WalrusBlob with `owner_address` set. Counting by owner is the
      // closest per-user proxy. Fast — index-only count on owner_address.
      prismaQuery.walrusBlob.count({
        where: {
          owner_address: profile.sui_address,
          deleted_at: null,
          tx_digest: { not: null },
        },
      }),
      // sum(notional) → BigInt; then we convert to DBUSDC human units
      // (FLOAT_SCALING = 1e9 per Trade.notional column comment). Decimal
      // string so we don't lose precision in JSON.
      prismaQuery.trade.aggregate({
        where: { trader_profile_id: profile.id, deleted_at: null },
        _sum: { notional: true },
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
      prismaQuery.trade.findMany({
        where: { trader_profile_id: profile.id, deleted_at: null },
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          side: true,
          price: true,
          quantity: true,
          notional: true,
          walrus_blob_id: true,
          tx_digest: true,
          created_at: true,
        },
      }),
    ]);

    const totalNotionalRaw = notionalAgg._sum.notional ?? 0n;
    const totalNotional = bigIntDivToDecimalString(totalNotionalRaw, 1_000_000_000n);
    const avatarUrl = profile.avatar_blob_id
      ? `${WALRUS_AGGREGATOR_URL}/v1/blobs/${profile.avatar_blob_id}`
      : null;

    return {
      suinsName: profile.suins_name,
      suiAddress: profile.sui_address,
      profileObjectId: profile.profile_object_id,
      balanceManagerId: profile.balance_manager_id,
      executorAgentId: profile.executor_agent_id,
      avatarBlobId: profile.avatar_blob_id,
      avatarUrl,
      bio: profile.bio,
      memberSinceMs: profile.created_at.getTime(),
      createdAt: profile.created_at,
      walrusSiteObjectId: null,
      counts: {
        tradesPlaced: tradesCount,
        // Renamed in spirit: per-user count instead of protocol-wide.
        anchorCount: anchorsCount,
      },
      tradesPlaced: tradesCount,
      anchorCount: anchorsCount,
      totalNotional,
      recentTrades: recentTrades.map((t) => ({
        side: t.side,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        notional: t.notional.toString(),
        walrusBlobId: t.walrus_blob_id,
        txDigest: t.tx_digest,
        createdAt: t.created_at,
      })),
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
    };
  }

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
        const cacheKey = bySuinsCacheKey(name);
        const cached = BY_SUINS_CACHE.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
          return reply.code(200).send({ success: true, error: null, data: cached.value });
        }
        const address = await resolveSuiNS(name);
        if (!address) return handleNotFoundError(reply, `SuiNS name "${name}"`);
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { sui_address: address },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');

        const data = await enrichProfile({
          id: profile.id,
          sui_address: profile.sui_address,
          suins_name: profile.suins_name ?? name,
          profile_object_id: profile.profile_object_id,
          balance_manager_id: profile.balance_manager_id,
          executor_agent_id: profile.executor_agent_id,
          avatar_blob_id: profile.avatar_blob_id,
          bio: profile.bio,
          created_at: profile.created_at,
        });
        BY_SUINS_CACHE.set(cacheKey, { value: data, expires: Date.now() + BY_SUINS_TTL_MS });
        return reply.code(200).send({ success: true, error: null, data });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── GET /profile/by-address/:address ──────────────────────────────────
  // Public mirror of /by-suins for direct address lookups (when the user
  // has no SuiNS apex set). Same enrichment payload.
  app.get(
    '/by-address/:address',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { address } = request.params as { address: string };
      if (!address) return handleError(reply, 400, 'missing address', 'MISSING_PARAM');
      if (!/^0x[a-f0-9]{64}$/i.test(address)) {
        return handleError(reply, 400, 'invalid sui address', 'BAD_ADDRESS');
      }
      try {
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { sui_address: address.toLowerCase() },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');
        const data = await enrichProfile({
          id: profile.id,
          sui_address: profile.sui_address,
          suins_name: profile.suins_name,
          profile_object_id: profile.profile_object_id,
          balance_manager_id: profile.balance_manager_id,
          executor_agent_id: profile.executor_agent_id,
          avatar_blob_id: profile.avatar_blob_id,
          bio: profile.bio,
          created_at: profile.created_at,
        });
        return reply.code(200).send({ success: true, error: null, data });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /profile/me/avatar ───────────────────────────────────────────
  //
  // Body: { blobId, mimeType }. We persist `avatar_blob_id` only; the
  // mimeType is validated as an allowlist (image/png|jpeg|webp) so the
  // caller can't slip in `image/svg+xml` which would XSS when the
  // aggregator returns octet-stream and the browser sniffs content.
  //
  // The actual blob bytes are NOT proxied through this server — we trust
  // the client to have uploaded a real PNG/JPEG/WebP to Walrus. A future
  // upgrade can fetch the first 12 bytes from the aggregator and verify
  // the magic-byte header server-side; for v1, mime-allowlist + frontend
  // contract is the agreed boundary per the brief.
  app.post(
    '/me/avatar',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      const body = request.body as AvatarBody;
      const missing: string[] = [];
      if (typeof body?.blobId !== 'string' || body.blobId.length === 0) missing.push('blobId');
      if (typeof body?.mimeType !== 'string' || body.mimeType.length === 0) missing.push('mimeType');
      if (missing.length) return handleValidationError(reply, missing);

      const blobId = body.blobId!.trim();
      const mimeType = body.mimeType!.trim().toLowerCase();
      if (blobId.length < BLOB_ID_MIN || blobId.length > BLOB_ID_MAX || !BLOB_ID_RE.test(blobId)) {
        return handleError(
          reply,
          400,
          `blobId must be ${BLOB_ID_MIN}-${BLOB_ID_MAX} URL-safe base64 characters`,
          'BAD_BLOB_ID',
        );
      }
      if (!AVATAR_ALLOWED_MIME.has(mimeType)) {
        return handleError(
          reply,
          400,
          'mimeType must be image/png, image/jpeg, or image/webp',
          'BAD_MIME',
        );
      }

      try {
        const updated = await prismaQuery.traderProfile.update({
          where: { sui_address: user.sui_address },
          data: { avatar_blob_id: blobId },
          select: { avatar_blob_id: true, suins_name: true },
        });
        invalidateBySuinsCache(updated.suins_name);
        const avatarUrl = `${WALRUS_AGGREGATOR_URL}/v1/blobs/${updated.avatar_blob_id}`;
        return reply.code(200).send({
          success: true,
          error: null,
          data: { avatarBlobId: updated.avatar_blob_id, avatarUrl },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /profile/me/bio ──────────────────────────────────────────────
  //
  // Body: { bio }. Trimmed, capped at 280 chars. Empty string clears the
  // column (stored as NULL so future queries can short-circuit cleanly).
  // No HTML/markdown processing here — the frontend is expected to render
  // bio as plain text via React's default escaping. Anything that looks
  // like HTML stays escaped on render; we don't strip server-side because
  // strip-on-write loses round-trip fidelity and the canonical defense is
  // context-aware output encoding at render time (OWASP XSS cheat sheet).
  app.post(
    '/me/bio',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      const body = request.body as BioBody;
      if (typeof body?.bio !== 'string') return handleValidationError(reply, ['bio']);
      const trimmed = body.bio.trim();
      if (trimmed.length > BIO_MAX) {
        return handleError(reply, 400, `bio must be <= ${BIO_MAX} chars`, 'BIO_TOO_LONG');
      }
      const value = trimmed.length === 0 ? null : trimmed;
      try {
        const updated = await prismaQuery.traderProfile.update({
          where: { sui_address: user.sui_address },
          data: { bio: value },
          select: { bio: true, suins_name: true },
        });
        invalidateBySuinsCache(updated.suins_name);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { bio: updated.bio },
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
