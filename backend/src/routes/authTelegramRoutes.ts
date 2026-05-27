/**
 * POST /auth/telegram/verify
 *
 * Verifies a Telegram Mini App `initData` and issues a server JWT.
 * Generates an OAuth nonce bound to the telegram_user_id_hash for the
 * subsequent zkLogin (Google) step (LIGHTHOUSE.md §15.2b).
 *
 * Response includes:
 *   - `jwt`: server-issued, used for subsequent backend calls
 *   - `oauthUrl`: where to send the user for Google sign-in (system browser)
 *   - `nonce`: client convenience (echoed; binding is server-side)
 *
 * SECURITY:
 *   - initData verification is canonical two-stage HMAC (see lib/telegram.ts)
 *   - nonce is single-use, 5-minute TTL
 *   - telegram_user_id is HASHED before persistence
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';

import {
  JWT_EXPIRES_IN,
  JWT_SECRET,
  OAUTH_CALLBACK,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { hashTelegramUserId, verifyTelegramInitData } from '../lib/telegram.ts';
import { createNonce } from '../lib/zklogin.ts';
import {
  handleError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface VerifyBody {
  initData?: string;
}

export const authTelegramRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as VerifyBody;
    if (!body?.initData) {
      return handleValidationError(reply, ['initData']);
    }

    let verified;
    try {
      verified = verifyTelegramInitData(body.initData);
    } catch (e) {
      return handleError(reply, 401, 'invalid Telegram initData', 'TG_INITDATA_INVALID', e as Error);
    }

    let tgHash: string;
    try {
      tgHash = hashTelegramUserId(verified.telegramUserId);
    } catch (e) {
      return handleServerError(reply, e as Error);
    }

    // 5-min OAuth state nonce, bound to this telegram user.
    // We also generate the Enoki zkLogin nonce here so the user's OAuth flow
    // produces a JWT bound to a fresh ephemeral keypair. State is persisted
    // alongside the OAuthNonce row for the /oauth/callback to consume.
    const nonce = nanoid(32);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    let zkState;
    try {
      zkState = await createNonce();
    } catch (e) {
      return handleError(reply, 500, 'failed to create zkLogin nonce', 'ZKLOGIN_NONCE_FAILED', e as Error);
    }

    try {
      await prismaQuery.oAuthNonce.create({
        data: {
          nonce,
          telegram_user_id_hash: tgHash,
          expires_at: expiresAt,
          zklogin_state: zkState as unknown as never,
        },
      });
    } catch (e) {
      return handleError(reply, 500, 'failed to persist oauth nonce', 'OAUTH_NONCE_PERSIST_FAILED', e as Error);
    }

    // Look up existing binding if any (returning user).
    const existing = await prismaQuery.telegramUser.findUnique({
      where: { telegram_user_id_hash: tgHash },
      include: { trader_profile: true },
    });

    // Server JWT (used by frontend for /coach/recommend etc.)
    const token = jwt.sign(
      {
        sub: tgHash,
        kind: 'telegram',
        sui_address: existing?.trader_profile.sui_address ?? null,
        profile_id: existing?.trader_profile.profile_object_id ?? null,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
    );

    // Build Google OAuth URL. CLIENT_ID is required; if missing, return the
    // state and let the frontend assemble the URL with its own client id.
    const googleClientId = process.env.GOOGLE_CLIENT_ID ?? '';
    const oauthUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?response_type=code` +
      `&scope=${encodeURIComponent('openid email profile')}` +
      `&state=${nonce}` +
      `&nonce=${encodeURIComponent(zkState.nonce)}` +
      `&client_id=${encodeURIComponent(googleClientId)}` +
      `&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}`;

    return reply.code(200).send({
      success: true,
      error: null,
      data: {
        jwt: token,
        nonce,
        oauthUrl,
        existing: !!existing,
        suiAddress: existing?.trader_profile.sui_address ?? null,
      },
    });
  });

  done();
};
