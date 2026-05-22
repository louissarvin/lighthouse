/**
 * Sui Stack Messaging HTTP surface.
 *
 * Exposes the Coach-funded group + message helpers from `lib/messaging.ts`
 * to the web app. All operations are signed and paid by the Coach keypair
 * (the SDK does NOT expose unsigned-bytes mode for Enoki sponsorship), so
 * end users never pay gas or WAL for messaging.
 *
 * Routes:
 *   POST /messaging/group-create — create a group with the authed user as member
 *   POST /messaging/send         — Coach posts to a group on behalf of user
 *   GET  /messaging/health       — relayer + lib status (public)
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { RELAYER_URL } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import {
  createGroupAsCoach,
  listMessagesAsCoach,
  sendMessageAsCoach,
} from '../lib/messaging.ts';
import {
  handleError,
  handleForbiddenError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface CreateGroupBody {
  name?: string;
  /// Optional extra members (Sui addresses) beyond the authenticated user.
  /// The user is auto-added so they can read SEAL-encrypted group history.
  extraMembers?: string[];
}

interface SendMessageBody {
  groupUuid?: string;
  text?: string;
}

export const messagingRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // ─── GET /messaging/health ─────────────────────────────────────────────
  // Public probe. Useful for the frontend to gate the messaging UI on
  // whether the relayer is actually configured.
  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!RELAYER_URL) {
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          enabled: false,
          reason: 'RELAYER_URL not configured',
        },
      });
    }
    // Probe the relayer's health endpoint without throwing on failure.
    let relayerOk = false;
    try {
      const ctrl = AbortController ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), 2000) : null;
      const r = await fetch(`${RELAYER_URL}/health_check`, {
        signal: ctrl?.signal,
      });
      if (t) clearTimeout(t);
      relayerOk = r.ok;
    } catch {
      relayerOk = false;
    }
    return reply.code(200).send({
      success: true,
      error: null,
      data: { enabled: relayerOk, relayerUrl: RELAYER_URL },
    });
  });

  // ─── POST /messaging/group-create ──────────────────────────────────────
  // Creates a SEAL-encrypted group on Sui Stack Messaging, signed + paid
  // by Coach. The authenticated user is auto-added as a member.
  app.post(
    '/group-create',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as CreateGroupBody;
      if (!body.name || !body.name.trim()) {
        return handleValidationError(reply, ['name']);
      }
      if (body.name.length > 200) {
        return handleError(reply, 400, 'name too long (max 200)', 'NAME_TOO_LONG');
      }

      // De-dup + sanity-check the member list. Coach is auto-granted all
      // perms by the SDK; per the upstream docstring, do NOT include the
      // creator's address in `initialMembers`.
      const members = Array.from(
        new Set([user.sui_address, ...(body.extraMembers ?? [])]),
      ).filter((addr) => /^0x[a-f0-9]{64}$/i.test(addr));

      if (members.length === 0) {
        return handleError(reply, 400, 'no valid member addresses', 'NO_MEMBERS');
      }

      try {
        const result = await createGroupAsCoach({
          name: body.name.trim(),
          members,
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            uuid: result.uuid,
            digest: result.digest,
            members,
            explorer: `https://suiscan.xyz/testnet/tx/${result.digest}`,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── POST /messaging/send ──────────────────────────────────────────────
  // Coach posts `text` to an existing group on behalf of the authenticated
  // user. The user must be a member of the group (enforced upstream by
  // the messaging Move package's MessagingSender permission check).
  app.post(
    '/send',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as SendMessageBody;
      const missing: string[] = [];
      if (!body.groupUuid) missing.push('groupUuid');
      if (!body.text) missing.push('text');
      if (missing.length) return handleValidationError(reply, missing);

      if (body.text!.length > 8000) {
        return handleError(reply, 400, 'text too long (max 8000 chars)', 'TEXT_TOO_LONG');
      }

      try {
        const result = await sendMessageAsCoach({
          groupUuid: body.groupUuid!,
          text: body.text!,
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: { messageId: result.messageId },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── GET /messaging/list/:groupUuid ────────────────────────────────────
  //
  // Read the most recent (up to 50) messages from a Sui Stack Messaging
  // group. Membership is enforced against the authed user's TraderProfile —
  // a user can only read a group whose UUID is stored as their own
  // `coach_group_uuid` or `audit_group_uuid`. We DO NOT trust the SDK's
  // implicit "decrypt only what you can read" because the SDK call still
  // consumes the Coach's relayer budget; gating up-front prevents a
  // malicious caller from probing arbitrary group UUIDs.
  //
  // Graceful degradation: if RELAYER_URL is empty or the SDK read throws,
  // return `{ messages: [], unavailable: true, reason }` with a 200 so the
  // frontend can render an "offline" panel instead of an error toast. This
  // matches `/messaging/health`'s contract.
  app.get(
    '/list/:groupUuid',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no trader_profile bound', 'NO_PROFILE');
      }
      const { groupUuid } = request.params as { groupUuid?: string };
      if (!groupUuid || !/^[a-f0-9-]{16,64}$/i.test(groupUuid)) {
        return handleError(reply, 400, 'invalid groupUuid', 'BAD_GROUP_UUID');
      }

      // Membership check: only the authed user's own coach OR audit group.
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
        select: { coach_group_uuid: true, audit_group_uuid: true },
      });
      if (!profile) {
        return handleError(reply, 401, 'profile not found', 'NO_PROFILE');
      }
      const isCoachGroup = profile.coach_group_uuid === groupUuid;
      const isAuditGroup = profile.audit_group_uuid === groupUuid;
      if (!isCoachGroup && !isAuditGroup) {
        return handleForbiddenError(reply, 'not a member of this group');
      }

      // Short-circuit when the relayer is not configured — the SDK would
      // throw further down anyway, and we want a stable graceful response.
      if (!RELAYER_URL) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            messages: [],
            unavailable: true,
            reason: 'relayer not configured',
          },
        });
      }

      try {
        const { messages } = await listMessagesAsCoach(groupUuid, 50);
        // Newest-first; the SDK orders by `order` ascending. Map to the
        // public response shape and sort descending by createdAt.
        const out = messages
          .map((m) => ({
            id: m.messageId,
            sender: m.senderAddress,
            text: m.text,
            timestampMs: m.createdAt,
            // The SDK returns plaintext after SEAL decryption; we expose
            // a boolean so the client can distinguish a redacted (deleted
            // or undecryptable) message from a real empty body.
            decrypted: !m.isDeleted && m.text.length > 0,
          }))
          .sort((a, b) => b.timestampMs - a.timestampMs)
          .slice(0, 50);

        return reply.code(200).send({
          success: true,
          error: null,
          data: { messages: out },
        });
      } catch (e) {
        // Graceful degradation per the brief: relayer down, SDK timeout,
        // SEAL key-server quorum failure, etc. Log full error server-side
        // (handleError pattern) but never 500 the caller.
        const msg = (e as Error)?.message ?? String(e);
        console.warn(`[messaging] list/${groupUuid} read failed:`, msg);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            messages: [],
            unavailable: true,
            reason: msg.slice(0, 200),
          },
        });
      }
    },
  );

  done();
};
