/**
 * Telegram webhook receiver.
 *
 * POST /tg/webhook
 *   Telegram POSTs update JSON here when you've set the bot's webhook URL via
 *   `bot.api.setWebhook(...)`. In dev you can skip the webhook and use
 *   `bot.startPolling()` instead (see `index.ts`).
 *
 * SECURITY:
 *   - Telegram includes the `X-Telegram-Bot-Api-Secret-Token` header on every
 *     delivery whenever `setWebhook` was called with a `secret_token` param.
 *     We validate it against `TELEGRAM_WEBHOOK_SECRET_TOKEN` using a
 *     constant-time comparison (timing side-channel safe). Missing or wrong
 *     token returns 401 with a generic body (no echo of the received token).
 *     See: https://core.telegram.org/bots/api#setwebhook
 *   - When rotating the secret, re-register the webhook with the new value:
 *       curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
 *         -d "url=${PUBLIC_BASE_URL}/tg/webhook" \
 *         -d "secret_token=${TELEGRAM_WEBHOOK_SECRET_TOKEN}"
 *   - Per-IP rate limit is applied by `@fastify/rate-limit` via the route's
 *     `config.rateLimit` block below. The secret-token check runs FIRST so
 *     spoofed requests are dropped before they consume Atoma quota.
 *   - We rely on the bot library to validate the update shape; malformed
 *     bodies are rejected by grammY.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { IS_PROD, TELEGRAM_WEBHOOK_SECRET_TOKEN } from '../config/main-config.ts';
import { getTelegramBot } from '../lib/telegramBot.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Constant-time comparison of the received `X-Telegram-Bot-Api-Secret-Token`
 * header against the configured secret.
 *
 * - Hashes both inputs to SHA-256 (32-byte) buffers so `timingSafeEqual` never
 *   throws on length mismatch and so attacker-controlled length probing cannot
 *   distinguish "wrong length" from "wrong value".
 * - Production fail-closed: if the env var is empty, every request is rejected.
 * - Dev fail-open: empty env var accepts the request (boot already logged a
 *   warning in `main-config.ts`).
 */
function isValidSecretToken(received: string | undefined): boolean {
  if (!TELEGRAM_WEBHOOK_SECRET_TOKEN) {
    return !IS_PROD;
  }
  if (!received) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(TELEGRAM_WEBHOOK_SECRET_TOKEN).digest();
  return timingSafeEqual(a, b);
}

export const telegramWebhookRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/webhook',
    {
      config: {
        // Telegram retries delivery on transient 5xx; 30/min/IP is enough
        // headroom for legitimate bursts while bounding flood damage from a
        // forged source that somehow guesses the secret.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 1. Secret-token check FIRST — drop spoofed updates before doing any
      //    bot/handler/DB work. Header lookup is lowercase per Fastify
      //    normalisation. Never log the received value.
      const headerVal = request.headers[TELEGRAM_SECRET_HEADER];
      const received = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (!isValidSecretToken(received)) {
        return handleError(reply, 401, 'Unauthorized', 'TG_WEBHOOK_UNAUTHORIZED');
      }

      const bot = getTelegramBot();
      if (!bot.enabled) {
        return handleError(reply, 503, 'Telegram bot is not configured', 'TG_BOT_DISABLED');
      }
      const handler = bot.webhookHandler();
      if (!handler) {
        return handleError(reply, 503, 'Webhook handler missing', 'TG_HANDLER_MISSING');
      }
      try {
        // grammY's std/http handler expects a fetch-style Request. Build one
        // from Fastify's parsed body so we don't have to re-stream the raw body.
        const fetchReq = new Request(
          `http://localhost${request.url}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body ?? {}),
          },
        );
        const fetchRes = await (handler as (req: Request) => Promise<Response>)(fetchReq);
        // grammY responds with a 200 + empty body on success; mirror that.
        const text = await fetchRes.text();
        return reply.code(fetchRes.status).send(text || { ok: true });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
