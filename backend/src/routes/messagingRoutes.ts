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
import {
  createGroupAsCoach,
  sendMessageAsCoach,
} from '../lib/messaging.ts';
import {
  handleError,
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

  done();
};
