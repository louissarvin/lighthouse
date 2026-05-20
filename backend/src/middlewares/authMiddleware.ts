/**
 * Auth middleware — validates a server-issued JWT (issued by
 * `/auth/telegram/verify` after canonical Telegram initData verification).
 *
 * JWT payload shape:
 *   { sub: telegram_user_id_hash, kind: 'telegram', sui_address?, profile_id? }
 *
 * On success `request.user` is populated with the bound TraderProfile (if any).
 */

import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { JWT_SECRET, WEB_COOKIE_NAME } from '../config/main-config.ts';
import { handleError } from '../utils/errorHandler.ts';

interface JwtPayload {
  sub: string;
  kind: 'telegram' | 'zklogin';
  sui_address?: string | null;
  profile_id?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      telegram_user_id_hash: string;
      sui_address: string | null;
      trader_profile_id: string | null;
    };
  }
}

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<true | FastifyReply> => {
  // Accept either: 1) `Authorization: Bearer <jwt>` (Telegram bot / curl / tests)
  // or 2) the `lh_jwt` httpOnly cookie (web SPA, set by /auth/web/set-cookie).
  //
  // Fastify-cookie auto-populates `request.cookies`. When the plugin isn't
  // registered we still hold up via the Authorization header.
  const authHeader = request.headers.authorization;
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const cookieToken = cookies ? cookies[WEB_COOKIE_NAME] : undefined;

  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (cookieToken) {
    token = cookieToken;
  }

  if (!token) {
    return handleError(reply, 401, 'Missing or invalid authorization header', 'MISSING_AUTH_HEADER');
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch (error) {
    return handleError(reply, 401, 'Invalid or expired token', 'INVALID_TOKEN', error as Error);
  }
  if (!payload?.sub) {
    return handleError(reply, 401, 'Invalid token payload', 'INVALID_TOKEN_PAYLOAD');
  }

  // Telegram-bound JWTs always have a hashed tg user id in `sub`.
  if (payload.kind === 'telegram') {
    const tgUser = await prismaQuery.telegramUser.findUnique({
      where: { telegram_user_id_hash: payload.sub },
      include: { trader_profile: true },
    });
    if (!tgUser) {
      return handleError(reply, 401, 'Telegram user not bound', 'TG_USER_NOT_FOUND');
    }
    request.user = {
      id: tgUser.id,
      telegram_user_id_hash: tgUser.telegram_user_id_hash,
      sui_address: tgUser.trader_profile.sui_address,
      trader_profile_id: tgUser.trader_profile_id,
    };
    return true;
  }

  // zklogin JWTs (future) carry sui_address directly.
  if (payload.kind === 'zklogin' && payload.sui_address) {
    const profile = await prismaQuery.traderProfile.findUnique({
      where: { sui_address: payload.sui_address },
    });
    request.user = {
      id: profile?.id ?? '',
      telegram_user_id_hash: '',
      sui_address: payload.sui_address,
      trader_profile_id: profile?.id ?? null,
    };
    return true;
  }

  return handleError(reply, 401, 'Unsupported JWT kind', 'BAD_JWT_KIND');
};
