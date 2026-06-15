/**
 * Lighthouse backend centralized configuration.
 *
 * All commonly used environment variables MUST be defined here. Import from
 * this file rather than touching `process.env` directly — keeps env access
 * explicit, typed, and fail-fast on boot.
 *
 * See `backend/ENV_SETUP.md` for the canonical .env.example contents.
 * Testnet addresses come from `memory/lighthouse_testnet_plan_2026_06.md`.
 */

// === Required env vars (boot-time validation) ===

const requiredEnvVars: string[] = [
  'DATABASE_URL',
  'JWT_SECRET',
  'SUI_NETWORK',
  'SUI_RPC_URL',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// === App ===

export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// === Database ===

export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// === Auth ===

export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';

// === Sui network ===

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';
export const SUI_NETWORK: SuiNetwork = (process.env.SUI_NETWORK || 'testnet') as SuiNetwork;
export const SUI_RPC_URL: string = process.env.SUI_RPC_URL as string;

// === Lighthouse Move package (set after publish) ===

export const LIGHTHOUSE_PACKAGE_ID: string = process.env.LIGHTHOUSE_PACKAGE_ID || '';
export const LIGHTHOUSE_VERSION_OBJECT_ID: string = process.env.LIGHTHOUSE_VERSION_OBJECT_ID || '';

// === Backend keypairs ===
//
// Two supported sources, checked in order by `src/lib/keypairs.ts`:
//   1. Env var `COACH_AGENT_PRIVATE_KEY` etc. — Bech32 (`suiprivkey1...`).
//   2. File `${LIGHTHOUSE_KEYS_DIR}/<address>.key` — 44-char base64
//      (33 bytes = 1 scheme flag + 32 secret key), filename = sui address.
//
// Default keys dir is `~/.lighthouse/keys` (OUTSIDE the repo, chmod 700).
// Never commit `.key` files; the project and repo-root `.gitignore` block
// `*.key` as defense in depth.

export const LIGHTHOUSE_KEYS_DIR: string =
  process.env.LIGHTHOUSE_KEYS_DIR || '~/.lighthouse/keys';

export const COACH_AGENT_PRIVATE_KEY: string = process.env.COACH_AGENT_PRIVATE_KEY || '';
export const EXECUTOR_AGENT_PRIVATE_KEY: string = process.env.EXECUTOR_AGENT_PRIVATE_KEY || '';
export const SETTLEMENT_KEEPER_PRIVATE_KEY: string = process.env.SETTLEMENT_KEEPER_PRIVATE_KEY || '';

// Optional: address hints, so the file-based loader knows which key file to
// open from `LIGHTHOUSE_KEYS_DIR` when the Bech32 env var is empty.
export const COACH_AGENT_ADDRESS: string = process.env.COACH_AGENT_ADDRESS || '';
export const EXECUTOR_AGENT_ADDRESS: string = process.env.EXECUTOR_AGENT_ADDRESS || '';
export const SETTLEMENT_KEEPER_ADDRESS: string = process.env.SETTLEMENT_KEEPER_ADDRESS || '';

// === Walrus ===

export const WALRUS_AGGREGATOR_URL: string =
  process.env.WALRUS_AGGREGATOR_URL || 'https://aggregator.walrus-testnet.walrus.space';
export const WALRUS_PUBLISHER_URL: string =
  process.env.WALRUS_PUBLISHER_URL || 'https://publisher.walrus-testnet.walrus.space';
export const WALRUS_UPLOAD_RELAY_HOST: string =
  process.env.WALRUS_UPLOAD_RELAY_HOST || 'https://upload-relay.testnet.walrus.space';
export const WALRUS_DEFAULT_EPOCHS: number = Number(process.env.WALRUS_DEFAULT_EPOCHS) || 53;

// === SEAL (testnet defaults; see memory/lighthouse_testnet_plan_2026_06.md §1.2) ===

export const SEAL_PACKAGE_ID: string =
  process.env.SEAL_PACKAGE_ID ||
  '0xdccbeb87767be2b2346af5575eb139807205e4c23ec53dc616f951fe1d814112';

export const SEAL_KEY_SERVER_IDS: string[] = (process.env.SEAL_KEY_SERVER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const SEAL_AGGREGATOR_URL: string =
  process.env.SEAL_AGGREGATOR_URL || 'https://seal-aggregator-testnet.mystenlabs.com';

// === MemWal ===

export const MEMWAL_RELAYER_URL: string =
  process.env.MEMWAL_RELAYER_URL || 'https://relayer-staging.memory.walrus.xyz';

export const MEMWAL_PACKAGE_ID: string =
  process.env.MEMWAL_PACKAGE_ID ||
  '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6';

export const MEMWAL_REGISTRY_ID: string =
  process.env.MEMWAL_REGISTRY_ID ||
  '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437';

/// Server-wide envelope key for per-user MemWal delegate key encryption.
/// MUST be a 32-byte secret encoded as hex (64 chars) or base64. Required for
/// the onboarding flow to succeed. Generate via `openssl rand -hex 32`.
export const MEMWAL_DELEGATE_ENCRYPTION_KEY: string =
  process.env.MEMWAL_DELEGATE_ENCRYPTION_KEY || '';

/// Cache TTL for the on-chain ExecutorAgent snapshot stored on TraderProfile.
/// Coach routes refresh the cache lazily when older than this.
export const EXECUTOR_AGENT_CACHE_TTL_MS: number =
  Number(process.env.EXECUTOR_AGENT_CACHE_TTL_MS) || 60_000;

// === DeepBook v3 (testnet) ===

export const DEEPBOOK_PACKAGE_ID: string = process.env.DEEPBOOK_PACKAGE_ID || '';
export const DEEPBOOK_REGISTRY_ID: string = process.env.DEEPBOOK_REGISTRY_ID || '';
export const DEEP_TREASURY_ID: string = process.env.DEEP_TREASURY_ID || '';
export const DEEPBOOK_SUI_DBUSDC_POOL: string =
  process.env.DEEPBOOK_SUI_DBUSDC_POOL ||
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5';
export const DEEPBOOK_DBUSDC_TYPE: string = process.env.DEEPBOOK_DBUSDC_TYPE || '';

// === Dev / test per-user state (testnet only) ===
export const DEV_BALANCE_MANAGER_ID: string = process.env.DEV_BALANCE_MANAGER_ID || '';
export const DEV_EXECUTOR_AGENT_ID: string = process.env.DEV_EXECUTOR_AGENT_ID || '';
export const DEV_TRADER_PROFILE_ID: string = process.env.DEV_TRADER_PROFILE_ID || '';

// === DeepBook Predict (testnet; v2 stretch) ===

export const PREDICT_PACKAGE_ID: string = process.env.PREDICT_PACKAGE_ID || '';
export const PREDICT_REGISTRY_ID: string = process.env.PREDICT_REGISTRY_ID || '';
export const PREDICT_SERVER_URL: string =
  process.env.PREDICT_SERVER_URL || 'https://predict-server.testnet.mystenlabs.com';
export const PREDICT_OBJECT_ID: string = process.env.PREDICT_OBJECT_ID || '';
export const PREDICT_MANAGER_ID: string = process.env.PREDICT_MANAGER_ID || '';
export const DUSDC_TYPE_TAG: string =
  process.env.DUSDC_TYPE_TAG ||
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';

// === Atoma (mainnet alpha — Sui-native decentralized inference) ===

export const ATOMASDK_BEARER_AUTH: string = process.env.ATOMASDK_BEARER_AUTH || '';
export const ATOMA_DEFAULT_MODEL: string =
  process.env.ATOMA_DEFAULT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';

// === Groq (centralized fallback for demo when Atoma key unavailable) ===
//
// If both `GROQ_API_KEY` and `ATOMASDK_BEARER_AUTH` are set, Groq wins
// (free tier, fastest inference, simplest to provision). Atoma stays the
// production aspiration for the Sui-native decentralized story.
export const GROQ_API_KEY: string = process.env.GROQ_API_KEY || '';
export const GROQ_DEFAULT_MODEL: string =
  process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile';

// === Sui Stack Messaging (BYO relayer; no Mysten-hosted testnet URL) ===

export const RELAYER_URL: string = process.env.RELAYER_URL || '';

// === Enoki ===

export const ENOKI_PRIVATE_KEY: string = process.env.ENOKI_PRIVATE_KEY || '';
/// Public Enoki API key. The BACKEND does NOT use this — it is declared
/// here so the env validator does not fail when ops sets it alongside the
/// private key. The value is intended for the web (exposed as
/// `VITE_ENOKI_PUBLIC_KEY`). Both keys MUST belong to the same Enoki app
/// or zkLogin-derived addresses will diverge across server/browser.
export const ENOKI_PUBLIC_KEY: string = process.env.ENOKI_PUBLIC_KEY || '';
export const ZKLOGIN_PROVER_URL: string =
  process.env.ZKLOGIN_PROVER_URL || 'https://prover-dev.mystenlabs.com/v1';
// Must match the route mounted by `oauthRoutes` (prefix '/oauth' + route '/callback').
// NO `/api/` prefix.
export const OAUTH_CALLBACK: string =
  process.env.OAUTH_CALLBACK || 'http://localhost:3700/oauth/callback';

// === Web app (SPA) ===
//
// Base URL the web app is served from. Used by /oauth/callback to redirect
// web-origin flows back to /oauth-finish. The web app also drives the cookie
// SameSite + Secure decision: when WEB_BASE_URL is on a different origin
// than the backend, cookies need SameSite=None; Secure.
export const WEB_BASE_URL: string =
  process.env.WEB_BASE_URL || 'http://localhost:3201';

// Cookie name for the session JWT.
export const WEB_COOKIE_NAME: string = process.env.WEB_COOKIE_NAME || 'lh_jwt';

// === Telegram ===

export const TELEGRAM_BOT_TOKEN: string = process.env.TELEGRAM_BOT_TOKEN || '';
export const TG_USER_ID_PEPPER: string = process.env.TG_USER_ID_PEPPER || '';

/// Secret token shared with Telegram via `setWebhook(secret_token=...)`.
/// Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token` on every webhook
/// delivery. Receiver MUST validate with constant-time comparison.
///
/// Allowed characters per Telegram Bot API: A-Z a-z 0-9 _ - (1..256 chars).
/// In production this is REQUIRED; missing -> fail-closed (webhook rejects).
/// In dev (NODE_ENV !== 'production') we warn and fail-open so local polling
/// + ngrok tunnels still work without provisioning a real token.
export const TELEGRAM_WEBHOOK_SECRET_TOKEN: string =
  process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || '';

if (!TELEGRAM_WEBHOOK_SECRET_TOKEN) {
  if (NODE_ENV === 'production') {
    console.error(
      'FATAL: TELEGRAM_WEBHOOK_SECRET_TOKEN is required in production. ' +
        'Generate via `openssl rand -hex 32`, set on the env, and rotate the ' +
        'webhook via Bot API `setWebhook?secret_token=...`.',
    );
    process.exit(1);
  } else {
    console.warn(
      '[config] TELEGRAM_WEBHOOK_SECRET_TOKEN is not set; the /tg/webhook ' +
        'route will accept unauthenticated updates (dev fail-open). DO NOT ' +
        'ship this configuration to production.',
    );
  }
}

// === Coach + Indexer tuning ===

export const COACH_GUARDIAN_MAX_SLIPPAGE_BPS: number =
  Number(process.env.COACH_GUARDIAN_MAX_SLIPPAGE_BPS) || 100;
export const COACH_GUARDIAN_MARKET_FRESHNESS_MS: number =
  Number(process.env.COACH_GUARDIAN_MARKET_FRESHNESS_MS) || 5000;
export const EVENT_INDEXER_RECONNECT_MS: number =
  Number(process.env.EVENT_INDEXER_RECONNECT_MS) || 3000;

// === Error Log Configuration ===

export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *';

// === Network timeouts ===

/// Default AbortSignal timeout (ms) for all outbound Sui RPC / HTTP calls.
/// Workers and services should use this instead of hardcoding 5000.
export const REQUEST_TIMEOUT_MS: number =
  Number(process.env.REQUEST_TIMEOUT_MS) || 5000;

// === Default export ===

export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  SUI_NETWORK,
  SUI_RPC_URL,
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
  LIGHTHOUSE_KEYS_DIR,
  COACH_AGENT_PRIVATE_KEY,
  EXECUTOR_AGENT_PRIVATE_KEY,
  SETTLEMENT_KEEPER_PRIVATE_KEY,
  COACH_AGENT_ADDRESS,
  EXECUTOR_AGENT_ADDRESS,
  SETTLEMENT_KEEPER_ADDRESS,
  WALRUS_AGGREGATOR_URL,
  WALRUS_PUBLISHER_URL,
  WALRUS_UPLOAD_RELAY_HOST,
  WALRUS_DEFAULT_EPOCHS,
  SEAL_PACKAGE_ID,
  SEAL_KEY_SERVER_IDS,
  SEAL_AGGREGATOR_URL,
  MEMWAL_RELAYER_URL,
  MEMWAL_PACKAGE_ID,
  MEMWAL_REGISTRY_ID,
  MEMWAL_DELEGATE_ENCRYPTION_KEY,
  EXECUTOR_AGENT_CACHE_TTL_MS,
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_REGISTRY_ID,
  DEEP_TREASURY_ID,
  DEEPBOOK_SUI_DBUSDC_POOL,
  DEEPBOOK_DBUSDC_TYPE,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
  PREDICT_SERVER_URL,
  PREDICT_OBJECT_ID,
  PREDICT_MANAGER_ID,
  DUSDC_TYPE_TAG,
  ATOMASDK_BEARER_AUTH,
  ATOMA_DEFAULT_MODEL,
  RELAYER_URL,
  ENOKI_PRIVATE_KEY,
  ENOKI_PUBLIC_KEY,
  ZKLOGIN_PROVER_URL,
  OAUTH_CALLBACK,
  WEB_BASE_URL,
  WEB_COOKIE_NAME,
  TELEGRAM_BOT_TOKEN,
  TG_USER_ID_PEPPER,
  TELEGRAM_WEBHOOK_SECRET_TOKEN,
  COACH_GUARDIAN_MAX_SLIPPAGE_BPS,
  COACH_GUARDIAN_MARKET_FRESHNESS_MS,
  EVENT_INDEXER_RECONNECT_MS,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
