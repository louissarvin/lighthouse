/**
 * GET  /notifications/recent   — last N notifications for the authed user.
 * POST /notifications/mark-read — mark one or all notifications read.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import {
  handleError,
  handleServerError,
} from '../utils/errorHandler.ts';

export const notificationRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // GET /notifications/recent?limit=20
  app.get(
    '/recent',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const qs = request.query as { limit?: string };
      // Default 50 per spec; cap 200 to keep payloads sane and protect the
      // (trader_profile_id, created_at) index.
      const limit = Math.min(Math.max(parseInt(qs.limit ?? '50', 10) || 50, 1), 200);
      try {
        const [rows, unreadCount] = await Promise.all([
          prismaQuery.notification.findMany({
            where: { trader_profile_id: user.trader_profile_id },
            orderBy: { created_at: 'desc' },
            take: limit,
          }),
          prismaQuery.notification.count({
            where: {
              trader_profile_id: user.trader_profile_id,
              read_at: null,
            },
          }),
        ]);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            unreadCount,
            notifications: rows.map((n) => ({
              id: n.id,
              kind: n.kind,
              title: n.title,
              body: n.body,
              payload: n.payload ?? null,
              readAt: n.read_at?.toISOString() ?? null,
              createdAt: n.created_at.toISOString(),
            })),
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // POST /notifications/mark-read
  // Body: { ids?: string[], id?: string } — `ids` per spec; `id` retained for
  // backwards compatibility with earlier clients. If neither, marks ALL unread.
  app.post(
    '/mark-read',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = (request.body ?? {}) as { ids?: unknown; id?: string };
      const now = new Date();

      // Normalize input. Defense: cap batch at 500 ids so a malicious caller
      // can't issue a giant UPDATE that locks the table.
      let idFilter: { in: string[] } | undefined;
      if (Array.isArray(body.ids)) {
        const safe = body.ids
          .filter((x): x is string => typeof x === 'string')
          .slice(0, 500);
        if (safe.length === 0) {
          return reply.code(200).send({
            success: true,
            error: null,
            data: { updated: 0 },
          });
        }
        idFilter = { in: safe };
      } else if (typeof body.id === 'string' && body.id) {
        idFilter = { in: [body.id] };
      }

      try {
        // updateMany WITH trader_profile_id filter — guarantees the caller
        // can only mark their OWN notifications read (A01 broken access
        // control defense).
        const result = await prismaQuery.notification.updateMany({
          where: {
            ...(idFilter ? { id: idFilter } : {}),
            trader_profile_id: user.trader_profile_id,
            read_at: null,
          },
          data: { read_at: now },
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: { updated: result.count },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
