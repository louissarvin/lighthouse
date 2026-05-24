/**
 * Telegram WebApp `initData` verifier.
 *
 * Canonical two-stage HMAC per https://core.telegram.org/bots/webapps
 *   secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
 *   expected   = HMAC_SHA256(key=secret_key,    message=data_check_string)
 *
 * NOTE: `"WebAppData"` is the literal HMAC KEY, NOT the message. Inverted
 * implementations silently accept forged data — this was the Pass 4
 * SECURITY-CRITICAL fix in LIGHTHOUSE.md §15.2.
 *
 * Always compare via `crypto.timingSafeEqual` after a length check.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { TELEGRAM_BOT_TOKEN, TG_USER_ID_PEPPER } from '../config/main-config.ts';

export interface VerifiedInitData {
  telegramUserId: number;
  username?: string;
  authDateUnix: number;
}

/**
 * Verify a Telegram WebApp `initData` URL-encoded string.
 *
 * @param initDataRaw    The full `Telegram.WebApp.initData` string.
 * @param maxAgeSeconds  Freshness window. Default 1h.
 */
export function verifyTelegramInitData(
  initDataRaw: string,
  maxAgeSeconds = 3600,
): VerifiedInitData {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('[telegram] TELEGRAM_BOT_TOKEN is not set');
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) throw new Error('missing hash');
  params.delete('hash');
  params.delete('signature'); // newer Ed25519 third-party path; not used here

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // TWO-STAGE HMAC. Key/message ordering matters.
  const secretKey = createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest();

  const provided = Buffer.from(hash, 'hex');
  if (provided.length !== expected.length) throw new Error('bad hash length');
  if (!timingSafeEqual(provided, expected)) throw new Error('bad hash');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) throw new Error('missing auth_date');
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > maxAgeSeconds) throw new Error('initData expired');
  // Allow up to 60s clock skew the other way (NTP drift).
  if (authDate - now > 60) throw new Error('auth_date in future (clock skew)');

  const userJson = params.get('user');
  if (!userJson) throw new Error('missing user');
  const user = JSON.parse(userJson) as { id: number; username?: string };
  if (typeof user.id !== 'number') throw new Error('bad user.id');

  return {
    telegramUserId: user.id,
    username: user.username,
    authDateUnix: authDate,
  };
}

/**
 * Peppered SHA-256 of telegram_user_id. PII defense per LIGHTHOUSE.md §15.2b.
 * NEVER persist the raw telegram_user_id; always store this hash.
 */
export function hashTelegramUserId(telegramUserId: number): string {
  if (!TG_USER_ID_PEPPER || TG_USER_ID_PEPPER.length < 16) {
    throw new Error('[telegram] TG_USER_ID_PEPPER must be set and >=16 chars');
  }
  return createHmac('sha256', TG_USER_ID_PEPPER)
    .update(String(telegramUserId))
    .digest('hex');
}

/**
 * Build a SHA-256 fingerprint for logging (no PII).
 */
export function fingerprintInitData(initDataRaw: string): string {
  return createHash('sha256').update(initDataRaw).digest('hex').slice(0, 16);
}
