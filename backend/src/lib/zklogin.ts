/**
 * Server-side zkLogin helpers via Enoki.
 *
 * Source: `@mysten/enoki@1.0.8` `EnokiClient/type.d.mts:22-86`, researcher Q8+Q9.
 *
 * Flow:
 *   1. Backend generates an ephemeral Ed25519 keypair.
 *   2. Backend calls `enoki.createZkLoginNonce({ network, ephemeralPublicKey })`
 *      → returns `{ nonce, randomness, maxEpoch, estimatedExpiration }`.
 *   3. Backend stores `{ ephemeralPrivateKey, randomness, maxEpoch }` in
 *      `OAuthNonce.zklogin_state` (JSON column).
 *   4. Backend redirects user to Google with `nonce` embedded in the OAuth URL.
 *   5. On callback, backend exchanges `code` for Google id_token at
 *      `oauth2.googleapis.com/token`.
 *   6. Backend calls `enoki.getZkLogin({ jwt: idToken })` → returns
 *      `{ address, publicKey, salt }`.
 *   7. Backend binds `sui_address = address` to the TraderProfile.
 *
 * `createZkLoginZkp` is needed only when the USER signs a Sui transaction
 * via zkLogin (Enoki sponsored or otherwise). We don't need it on the
 * onboarding path itself.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { getZkLoginSignature } from '@mysten/sui/zklogin';

import { getEnoki, executeSponsored } from './enoki.ts';
import { SUI_NETWORK } from '../config/main-config.ts';

export interface ZkLoginNonceState {
  /// Hex string of the ephemeral keypair's secret bytes. Persist with the
  /// OAuthNonce row so we can re-sign user transactions later.
  ephemeralSecretHex: string;
  /// Hex string of the ephemeral public key.
  ephemeralPublicKeyHex: string;
  /// Enoki-supplied randomness — needed by createZkLoginZkp later.
  randomness: string;
  /// The Sui epoch at which the proof expires.
  maxEpoch: number;
  /// The nonce embedded in the OAuth URL.
  nonce: string;
}

/**
 * Step 1-3: generate ephemeral keypair, get nonce from Enoki, return both
 * the state (caller persists) and the nonce (caller embeds in OAuth URL).
 */
export async function createNonce(): Promise<ZkLoginNonceState> {
  const ephemeral = Ed25519Keypair.generate();
  const ephemeralPublicKey = ephemeral.getPublicKey();
  const enoki = getEnoki();

  const network = SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const res = await enoki.createZkLoginNonce({
    network,
    ephemeralPublicKey,
  });

  // `Ed25519Keypair` does not expose the secret bytes directly in 2.17. The
  // canonical accessor is `getSecretKey()` (returns Bech32 string) — we hex-
  // encode the inner bytes via `decodeSuiPrivateKey`.
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  const bech32 = ephemeral.getSecretKey();
  const decoded = decodeSuiPrivateKey(bech32);

  return {
    ephemeralSecretHex: Buffer.from(decoded.secretKey).toString('hex'),
    ephemeralPublicKeyHex: Buffer.from(ephemeralPublicKey.toRawBytes()).toString('hex'),
    randomness: res.randomness,
    maxEpoch: res.maxEpoch,
    nonce: res.nonce,
  };
}

/**
 * Step 5-6: derive the user's Sui address from a Google `id_token` (JWT).
 * Enoki manages the salt server-side per its API key — we never see it.
 */
export async function deriveSuiAddressFromJwt(jwt: string): Promise<string> {
  const enoki = getEnoki();
  const res = await enoki.getZkLogin({ jwt });
  return res.address;
}

/**
 * Server-side sponsored-tx signing for a zkLogin-authenticated user.
 *
 * Sequence (researcher Q4 verbatim):
 *   1. Call `enoki.createZkLoginZkp({ network, jwt, ephemeralPublicKey, randomness, maxEpoch })`
 *      → `ZkLoginSignatureInputs`
 *   2. `ephemeralKeypair.signTransaction(fromBase64(sponsored.bytes))`
 *      → `{ signature: base64UserSig }`
 *   3. `getZkLoginSignature({ inputs, maxEpoch, userSignature: base64UserSig })`
 *      → wrapped zkLogin signature (base64 string)
 *   4. `enoki.executeSponsoredTransaction({ digest, signature: wrappedZk })`
 *
 * Source: researcher Q4 confirmation against
 *   - `@mysten/enoki/dist/EnokiClient/type.d.mts:54-83`
 *   - `@mysten/sui/dist/zklogin/signature.d.mts:1-28`
 *
 * @param sponsored        { digest, bytes } from `sponsorForAddress`.
 * @param state            Persisted ZkLoginNonceState from `createNonce` (decrypted).
 * @param jwt              The Google id_token that the OAuth callback received.
 */
export async function executeSponsoredAsZkLoginUser(args: {
  sponsored: { digest: string; bytes: string };
  state: ZkLoginNonceState;
  jwt: string;
}): Promise<{ digest: string }> {
  const enoki = getEnoki();
  const network = SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

  // 1. Reconstruct the ephemeral keypair we stored at nonce-creation time.
  const secretBytes = Buffer.from(args.state.ephemeralSecretHex, 'hex');
  const ephemeral = Ed25519Keypair.fromSecretKey(secretBytes);

  // 2. Ask Enoki to build the ZkLogin signature inputs (the ZKP) for THIS jwt.
  //    Returned object IS the `ZkLoginSignatureInputs`.
  const zkpInputs = await enoki.createZkLoginZkp({
    network,
    jwt: args.jwt,
    ephemeralPublicKey: ephemeral.getPublicKey(),
    randomness: args.state.randomness,
    maxEpoch: args.state.maxEpoch,
  });

  // 3. Sign the sponsored bytes with the ephemeral key. `signTransaction`
  //    returns `{ signature, bytes }` where signature is base64.
  const { signature: userSignature } = await ephemeral.signTransaction(
    fromBase64(args.sponsored.bytes),
  );

  // 4. Wrap into a zkLogin signature blob.
  const wrappedZk = getZkLoginSignature({
    inputs: zkpInputs,
    maxEpoch: args.state.maxEpoch,
    userSignature,
  });

  // 5. Execute through Enoki.
  return await executeSponsored(args.sponsored.digest, wrappedZk);
}

// Suppress unused-import warning if this file is tree-shaken in tests.
void decodeSuiPrivateKey;

/**
 * Exchange Google authorisation code for an id_token. Pure HTTP, no Enoki.
 *
 * Requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars + a matching
 * `redirect_uri` registered in the Google Cloud Console.
 */
export async function exchangeGoogleCode(args: {
  code: string;
  redirectUri: string;
}): Promise<{ idToken: string; accessToken: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('[zklogin] GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set');
  }
  const params = new URLSearchParams({
    code: args.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`[zklogin] Google token exchange failed: ${res.status} ${t}`);
  }
  const j = (await res.json()) as { id_token?: string; access_token?: string };
  if (!j.id_token) throw new Error('[zklogin] Google response missing id_token');
  return { idToken: j.id_token, accessToken: j.access_token ?? '' };
}

// ─── Server-driven OAuth flow (used by Telegram bot + web SPA) ───────────────

import { nanoid } from 'nanoid';
import { OAUTH_CALLBACK } from '../config/main-config.ts';
import { prismaQuery } from './prisma.ts';

export interface TelegramOAuthFlow {
  /// 5-min nonce persisted on OAuthNonce row. Used as Google `state` param +
  /// later validated on `/oauth/callback`.
  nonce: string;
  /// Fully-constructed Google OAuth URL. User just needs to open it.
  oauthUrl: string;
  /// When the OAuth nonce row expires.
  expiresAt: Date;
}

/**
 * Internal: build the OAuth flow with origin-aware OAuthNonce row creation.
 * Both `buildTelegramOAuthFlow` and `buildWebOAuthFlow` route through here.
 */
async function _buildOAuthFlow(args: {
  telegramUserIdHash: string;
  origin: 'telegram' | 'web';
  webRedirectUri?: string;
  action?: string;
  actionMeta?: Record<string, unknown>;
  /// TTL in milliseconds. Defaults to 5 minutes. Use a longer window for
  /// actions like `predict_redeem` where the user needs time to complete
  /// Google OAuth before the nonce expires.
  ttlMs?: number;
}): Promise<TelegramOAuthFlow> {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    throw new Error('[zklogin] GOOGLE_CLIENT_ID not set; cannot build OAuth URL');
  }

  const nonce = nanoid(32);
  const expiresAt = new Date(Date.now() + (args.ttlMs ?? 5 * 60 * 1000));
  const zkState = await createNonce();

  await prismaQuery.oAuthNonce.create({
    data: {
      nonce,
      telegram_user_id_hash: args.telegramUserIdHash,
      origin: args.origin,
      web_redirect_uri: args.webRedirectUri ?? null,
      expires_at: expiresAt,
      zklogin_state: zkState as unknown as never,
      action: args.action ?? null,
      action_meta: (args.actionMeta as unknown as never) ?? undefined,
    },
  });

  const oauthUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?response_type=code` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    `&state=${nonce}` +
    `&nonce=${encodeURIComponent(zkState.nonce)}` +
    `&client_id=${encodeURIComponent(googleClientId)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}`;

  return { nonce, oauthUrl, expiresAt };
}

/**
 * Build a complete Telegram→Google OAuth flow for `tgUserIdHash`.
 *   1. Generate ephemeral keypair + Enoki zkLogin nonce
 *   2. Persist OAuthNonce row (origin='telegram', 5-min TTL)
 *   3. Construct the Google OAuth URL
 *
 * Used by `/auth/telegram/verify` (Telegram Mini Apps) and the bot's
 * `/start` command for new users.
 *
 * SECURITY:
 *   - The nonce is single-use; `/oauth/callback` MUST mark `consumed_at`.
 *   - The 5-min TTL prevents stale OAuth flows.
 *   - The Telegram user ID is hashed before storage (PII defense).
 */
export async function buildTelegramOAuthFlow(
  tgUserIdHash: string,
  options?: { action?: string; action_meta?: Record<string, unknown>; ttlMs?: number },
): Promise<TelegramOAuthFlow> {
  return _buildOAuthFlow({
    telegramUserIdHash: tgUserIdHash,
    origin: 'telegram',
    action: options?.action,
    actionMeta: options?.action_meta,
    ttlMs: options?.ttlMs,
  });
}

/**
 * Build a complete Web→Google OAuth flow for a browser session. Unlike the
 * Telegram path there's no pre-existing `telegram_user_id_hash`; we synthesize
 * a per-flow opaque id (`web::<nanoid>`) so the OnboardingService path stays
 * uniform and the row's unique constraints stay non-colliding.
 *
 * @param webRedirectUri  Optional override for the post-auth /oauth-finish URL
 *                        on the SPA. Defaults to `${WEB_BASE_URL}/oauth-finish`.
 */
export async function buildWebOAuthFlow(args?: {
  webRedirectUri?: string;
  action?: string;
  actionMeta?: Record<string, unknown>;
  ttlMs?: number;
}): Promise<TelegramOAuthFlow & { telegramUserIdHash: string }> {
  const tgUserIdHash = `web::${nanoid(20)}`;
  const flow = await _buildOAuthFlow({
    telegramUserIdHash: tgUserIdHash,
    origin: 'web',
    webRedirectUri: args?.webRedirectUri,
    action: args?.action,
    actionMeta: args?.actionMeta,
    ttlMs: args?.ttlMs,
  });
  return { ...flow, telegramUserIdHash: tgUserIdHash };
}
