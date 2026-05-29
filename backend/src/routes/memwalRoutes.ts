/**
 * MemWal account bootstrap + recall routes.
 *
 * POST /memwal/begin
 *   Generates a fresh delegate key (or reuses an existing one), persists it
 *   encrypted, and returns sponsored PTB 1 (`create_account`).
 *   Response: { bytes, digest, delegatePublicKeyHex }
 *
 * POST /memwal/step2
 *   Body: { executedDigest: string, label?: string }
 *   Parses the user's PTB 1 result, extracts accountId, persists it, and
 *   returns sponsored PTB 2 (`add_delegate_key`).
 *   Response: { bytes, digest }
 *
 * GET /memwal/namespaces
 *   Returns the seven canonical namespaces (LIGHTHOUSE.md §7.1) along with
 *   the authed user's MemWal account id. Public-shape but auth-gated since
 *   we expose the account id.
 *
 * GET /memwal/recall?q=<query>&namespace=<ns>&limit=<k>
 *   Semantic recall against the user's encrypted memories. Returns
 *   `[{ blobId, text, distance }]`. Top-K per namespace; omit `namespace` to
 *   search ALL seven in parallel.
 *
 * The frontend signs each sponsored PTB and calls /sponsor/execute between
 * /begin and /step2.
 *
 * All routes are auth-gated.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { beginBootstrap, buildAddDelegatePtb } from '../services/MemWalBootstrap.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { envelopeDecrypt } from '../lib/envelope.ts';
import { NAMESPACES, recall, recallAll, rememberBulk } from '../lib/memwal.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface Step2Body {
  executedDigest?: string;
  label?: string;
}

interface RecallQuery {
  q?: string;
  namespace?: string;
  limit?: string;
}

interface RememberBulkBody {
  items?: Array<{ text?: unknown; namespace?: unknown }>;
}

const MAX_BULK_ITEMS = 20;
const MAX_BULK_TEXT_LEN = 16384;

const NAMESPACE_VALUES = new Set<string>(Object.values(NAMESPACES));

export const memwalRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post(
    '/begin',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no trader profile bound', 'NO_PROFILE');
      }
      try {
        const res = await beginBootstrap(user.trader_profile_id);
        return reply.code(200).send({ success: true, error: null, data: res });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/step2',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no trader profile bound', 'NO_PROFILE');
      }
      const body = request.body as Step2Body;
      if (!body?.executedDigest) {
        return handleValidationError(reply, ['executedDigest']);
      }
      try {
        const res = await buildAddDelegatePtb(
          user.trader_profile_id,
          body.executedDigest,
          body.label ?? `lighthouse:coach:${user.trader_profile_id.slice(0, 12)}`,
        );
        return reply.code(200).send({ success: true, error: null, data: res });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── GET /memwal/namespaces ───────────────────────────────────────────
  // Lists the 7 canonical Lighthouse namespaces plus the user's MemWal
  // account id. Frontend uses this to render the namespace explorer with
  // an empty state before any recall query fires.
  app.get(
    '/namespaces',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      // Static labels for the UI — derived from LIGHTHOUSE.md §7.1.
      const labels: Record<string, { label: string; description: string }> = {
        [NAMESPACES.preferences]: {
          label: 'Preferences',
          description: 'UI defaults, notification cadence, preferred pools.',
        },
        [NAMESPACES.riskProfile]: {
          label: 'Risk profile',
          description: 'Drawdown tolerance, sizing rules, time horizon.',
        },
        [NAMESPACES.holdingsHistory]: {
          label: 'Holdings history',
          description: 'Cost basis snapshots across BalanceManagers.',
        },
        [NAMESPACES.trades]: {
          label: 'Trades',
          description: 'Every coach decision and executor outcome.',
        },
        [NAMESPACES.coachPersonality]: {
          label: 'Coach personality',
          description: 'Tone tweaks, jargon level, narrative preferences.',
        },
        [NAMESPACES.lessonsLearned]: {
          label: 'Lessons learned',
          description: 'Post-mortems from blocked trades and losses.',
        },
        [NAMESPACES.goals]: {
          label: 'Goals',
          description: 'Targets, deadlines, capital allocation plans.',
        },
      };

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          memwalAccountId: profile.memwal_account_id,
          delegateConfigured: Boolean(profile.memwal_delegate_key_encrypted),
          namespaces: Object.values(NAMESPACES).map((ns) => ({
            namespace: ns,
            label: labels[ns]?.label ?? ns,
            description: labels[ns]?.description ?? '',
          })),
        },
      });
    },
  );

  // ─── GET /memwal/recall ───────────────────────────────────────────────
  // Semantic recall over the user's encrypted memories. The MemWal relayer
  // expects the user's delegate key — we hold it envelope-encrypted in the
  // DB so the user never has to handle it directly.
  //
  // Query params:
  //   q          — required. Free-text query (1..500 chars).
  //   namespace  — optional. Must be one of the 7 canonical namespaces.
  //                Omit to search across ALL namespaces.
  //   limit      — optional. 1..20 (default 5).
  app.get(
    '/recall',
    { preHandler: [authMiddleware], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      }
      const { q, namespace, limit: limitRaw } = request.query as RecallQuery;
      const missing: string[] = [];
      if (!q || typeof q !== 'string' || q.trim().length === 0) missing.push('q');
      if (missing.length) return handleValidationError(reply, missing);
      if (q!.length > 500) {
        return handleError(reply, 400, 'q too long (max 500)', 'QUERY_TOO_LONG');
      }
      if (namespace && !NAMESPACE_VALUES.has(namespace)) {
        return handleError(reply, 400, 'unknown namespace', 'BAD_NAMESPACE');
      }
      let limit = 5;
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
          return handleError(reply, 400, 'limit must be 1..20', 'BAD_LIMIT');
        }
        limit = Math.floor(parsed);
      }

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.memwal_account_id) {
        return handleError(reply, 409, 'memwal account not bootstrapped', 'MEMWAL_NOT_READY');
      }
      if (!profile.memwal_delegate_key_encrypted) {
        return handleError(
          reply,
          409,
          'memwal delegate key not provisioned',
          'MEMWAL_DELEGATE_MISSING',
        );
      }

      let delegateKey: string;
      try {
        delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
      } catch (e) {
        return handleError(
          reply,
          500,
          'failed to decrypt MemWal delegate key',
          'DELEGATE_DECRYPT_FAILED',
          e as Error,
        );
      }

      try {
        const account = { delegateKey, accountId: profile.memwal_account_id };
        const results = namespace
          ? await recall(account, q!, namespace, limit)
          : await recallAll(account, q!, Math.max(1, Math.ceil(limit / 7)));
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            query: q,
            namespace: namespace ?? null,
            results: results.slice(0, namespace ? limit : limit),
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /memwal/remember-bulk ───────────────────────────────────────
  // Persist up to 20 memories across any of the 7 canonical namespaces in
  // one round-trip to the MemWal relayer. Auth-gated; the user's delegate
  // key is loaded server-side from the envelope-encrypted column on
  // TraderProfile so the client never handles it directly.
  //
  // Body: { items: Array<{ text: string, namespace: string }> }
  // Response: { results: Array<{ blobId, namespace, status }> }
  app.post(
    '/remember-bulk',
    { preHandler: [authMiddleware], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      }

      const body = (request.body ?? {}) as RememberBulkBody;
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return handleError(reply, 400, 'items must be a non-empty array', 'BAD_ITEMS');
      }
      if (body.items.length > MAX_BULK_ITEMS) {
        return handleError(
          reply,
          400,
          `items must contain at most ${MAX_BULK_ITEMS} entries`,
          'TOO_MANY_ITEMS',
        );
      }

      const normalized: { text: string; namespace: string }[] = [];
      for (let i = 0; i < body.items.length; i++) {
        const it = body.items[i];
        const text = it?.text;
        const namespace = it?.namespace;
        if (typeof text !== 'string' || text.length === 0) {
          return handleError(
            reply,
            400,
            `items[${i}].text must be a non-empty string`,
            'BAD_ITEM_TEXT',
          );
        }
        if (text.length > MAX_BULK_TEXT_LEN) {
          return handleError(
            reply,
            400,
            `items[${i}].text exceeds ${MAX_BULK_TEXT_LEN} chars`,
            'ITEM_TEXT_TOO_LONG',
          );
        }
        if (typeof namespace !== 'string' || !NAMESPACE_VALUES.has(namespace)) {
          return handleError(
            reply,
            400,
            `items[${i}].namespace must be one of the 7 canonical namespaces`,
            'BAD_ITEM_NAMESPACE',
          );
        }
        normalized.push({ text, namespace });
      }

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.memwal_account_id) {
        return handleError(reply, 409, 'memwal account not bootstrapped', 'MEMWAL_NOT_READY');
      }
      if (!profile.memwal_delegate_key_encrypted) {
        return handleError(
          reply,
          409,
          'memwal delegate key not provisioned',
          'MEMWAL_DELEGATE_MISSING',
        );
      }

      let delegateKey: string;
      try {
        delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
      } catch (e) {
        return handleError(
          reply,
          500,
          'failed to decrypt MemWal delegate key',
          'DELEGATE_DECRYPT_FAILED',
          e as Error,
        );
      }

      try {
        const account = { delegateKey, accountId: profile.memwal_account_id };
        const results = await rememberBulk(account, normalized);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { results },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // POST /memwal/revoke
  // Clears the backend's envelope-encrypted MemWal delegate key.
  // After this call the backend can no longer write new memories for the
  // user until they re-run the MemWal bootstrap (/begin → /step2).
  // Rate-limited 10/min (destructive action).
  app.post(
    '/revoke',
    { preHandler: [authMiddleware], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.memwal_delegate_key_encrypted) {
        // Already revoked — idempotent 200.
        return reply.code(200).send({
          success: true,
          error: null,
          data: { revoked: true, alreadyClear: true },
        });
      }
      try {
        await prismaQuery.traderProfile.update({
          where: { id: profile.id },
          data: { memwal_delegate_key_encrypted: null },
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: { revoked: true, alreadyClear: false },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
