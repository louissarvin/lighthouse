/**
 * Web auth routes — companion to /oauth/callback for the lighthouse.wal.app SPA.
 *
 * Endpoints:
 *   POST /auth/web/start
 *     Body: { next?: string }
 *     -> { oauthUrl, nonce, expiresAt } — opens a fresh web-origin OAuth flow.
 *
 *   POST /auth/web/set-cookie
 *     Body: { handoff: string }
 *     -> burns the one-shot handoff token (issued by /oauth/callback) and
 *        sets an httpOnly cookie. The JWT NEVER touches client JS.
 *
 *   POST /auth/web/logout
 *     -> clears the cookie.
 *
 * SECURITY NOTES
 *   - The web-origin OAuthNonce TTL is 5 min (same as Telegram).
 *   - The WebAuthHandoff TTL is 2 min and single-use (consumed_at guard).
 *   - SameSite=None + Secure cookie is required for cross-origin SPA → API.
 *     Falls back to Lax in dev (http://localhost) where Secure is forbidden.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  IS_DEV,
  WEB_BASE_URL,
  WEB_COOKIE_NAME,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { buildWebOAuthFlow } from '../lib/zklogin.ts';
import {
  handleError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface StartBody {
  /// Optional in-app path to redirect to after auth completes. The SPA
  /// shuttles this through /oauth-finish; we never trust it on the backend
  /// beyond echoing through the redirect_uri.
  next?: string;
  /// Optional post-auth action to perform on /oauth/callback. Common values:
  /// 'deposit', 'predict_setup'. Persisted on the OAuthNonce row so the
  /// callback handler can dispatch.
  action?: string;
  /// Action-specific metadata (e.g. predict_setup target manager id). Merged
  /// with `amountMist` if provided. Persisted as Json on OAuthNonce.action_meta.
  actionMeta?: Record<string, unknown>;
  /// For action='deposit': SUI amount to deposit in MIST, as a stringified
  /// u64 (BigInt-safe over JSON). Folded into action_meta.
  amountMist?: string;
}

interface SetCookieBody {
  handoff?: string;
}

const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function buildCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'none';
  path: string;
  maxAge: number;
  partitioned: boolean;
} {
  // Modern browsers (Chrome / Safari / Firefox) treat `http://localhost` as a
  // "potentially trustworthy" origin and accept `Secure` cookies on it. That
  // lets us run the cross-site SPA → API flow in dev with the same
  // `SameSite=None; Secure` cookie shape we ship to production, avoiding the
  // Lax-only-on-top-level-nav trap that breaks background `fetch` carrying the
  // session cookie.
  //
  // `Partitioned` (CHIPS) is REQUIRED in modern Chrome (116+) for third-party
  // cookies — i.e. when the web origin (vercel.app) and API origin
  // (railway.app) have different registrable domains. Without it, the cookie
  // is silently dropped on subsequent cross-origin requests even though the
  // initial Set-Cookie succeeded. Symptom: /auth/web/set-cookie returns 200,
  // then /profile/me returns 401 because the cookie was never sent.
  // Doc: https://developers.google.com/privacy-sandbox/cookies/chips
  void IS_DEV;
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
    partitioned: true,
  };
}

export const authWebRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // POST /auth/web/start — kicks off a fresh Google OAuth flow.
  app.post('/start', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as StartBody | undefined) ?? {};
    const nextPath = typeof body.next === 'string' && body.next.startsWith('/') ? body.next : '/trade';

    // Optional post-auth action. Validate against an allowlist of actions the
    // web origin is actually wired to dispatch on /oauth/callback. The
    // callback handler also re-validates per-action; this is a defence-in-depth
    // boundary check so we don't persist nonces with garbage `action` values.
    const WEB_ALLOWED_ACTIONS = ['memwal_setup', 'predict_setup', 'sweep_to_bm'] as const;
    type WebAllowedAction = (typeof WEB_ALLOWED_ACTIONS)[number];

    let action: WebAllowedAction | undefined;
    if (typeof body.action === 'string' && body.action.length > 0) {
      if (!(WEB_ALLOWED_ACTIONS as readonly string[]).includes(body.action)) {
        return handleError(
          reply,
          400,
          `action must be one of: ${WEB_ALLOWED_ACTIONS.join(', ')}`,
          'BAD_ACTION',
        );
      }
      action = body.action as WebAllowedAction;
    }

    // Build the action_meta JSON blob. We accept a free-form object from the
    // client and additionally fold in amountMist (string, BigInt-safe) when
    // action='deposit'. We intentionally do NOT trust either as an
    // authorization signal — the OAuth callback re-derives identity from the
    // freshly issued JWT before doing anything with these fields.
    let actionMeta: Record<string, unknown> | undefined;
    if (action) {
      const incoming =
        body.actionMeta && typeof body.actionMeta === 'object' && !Array.isArray(body.actionMeta)
          ? { ...body.actionMeta }
          : {};
      if (typeof body.amountMist === 'string' && body.amountMist.length > 0) {
        // Validate amountMist is a non-negative integer string so we don't
        // persist garbage that a downstream BigInt() would throw on.
        if (!/^[0-9]+$/.test(body.amountMist)) {
          return handleError(reply, 400, 'amountMist must be a u64 string', 'BAD_AMOUNT_MIST');
        }
        incoming.amountMist = body.amountMist;
      }
      actionMeta = incoming;
    }

    try {
      // Build a per-flow redirect URI on the SPA. /oauth-finish reads
      // `handoff` from the query string.
      const url = new URL(`${WEB_BASE_URL}/oauth-finish`);
      url.searchParams.set('next', nextPath);

      // memwal_setup, predict_setup, and sweep_to_bm each run on-chain PTBs
      // inside the callback; give the user a longer window to complete Google
      // OAuth before the nonce expires. Mirrors the telegram /memwal flow.
      const ttlMs =
        action === 'memwal_setup' ||
        action === 'predict_setup' ||
        action === 'sweep_to_bm'
          ? 10 * 60 * 1000
          : undefined;

      const flow = await buildWebOAuthFlow({
        webRedirectUri: url.toString(),
        action,
        actionMeta,
        ttlMs,
      });

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          oauthUrl: flow.oauthUrl,
          nonce: flow.nonce,
          expiresAt: flow.expiresAt.toISOString(),
        },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  // POST /auth/web/set-cookie — burn handoff, set httpOnly cookie.
  app.post('/set-cookie', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as SetCookieBody | undefined) ?? {};
    if (!body.handoff || typeof body.handoff !== 'string') {
      return handleValidationError(reply, ['handoff']);
    }

    let handoff;
    try {
      handoff = await prismaQuery.webAuthHandoff.findUnique({
        where: { handoff_token: body.handoff },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }

    if (!handoff) {
      return handleError(reply, 400, 'invalid handoff token', 'HANDOFF_INVALID');
    }
    if (handoff.consumed_at) {
      return handleError(reply, 400, 'handoff already used', 'HANDOFF_REUSED');
    }
    if (handoff.expires_at.getTime() < Date.now()) {
      return handleError(reply, 400, 'handoff expired', 'HANDOFF_EXPIRED');
    }

    try {
      await prismaQuery.webAuthHandoff.update({
        where: { handoff_token: body.handoff },
        data: { consumed_at: new Date() },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }

    const opts = buildCookieOptions();
    reply.setCookie(WEB_COOKIE_NAME, handoff.jwt, opts);

    return reply.code(200).send({
      success: true,
      error: null,
      data: { suiAddress: handoff.sui_address },
    });
  });

  // POST /auth/web/logout — clear cookie.
  //
  // CRITICAL: the clear must match EVERY attribute on the original Set-Cookie
  // or Chrome treats it as a different cookie and leaves the original intact.
  // The original had `Partitioned; SameSite=None; Secure; Path=/`, so the clear
  // must too. Symptom of mismatch: POST /logout returns 200 but subsequent
  // /profile/me requests still succeed because the cookie was never cleared.
  app.post('/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(WEB_COOKIE_NAME, {
      path: '/',
      sameSite: 'none',
      secure: true,
      partitioned: true,
    });
    return reply.code(200).send({ success: true, error: null, data: { loggedOut: true } });
  });

  done();
};
