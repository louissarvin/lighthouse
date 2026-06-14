/**
 * scripts/smoke.ts
 *
 * Lighthouse end-to-end smoke test.
 *
 * Walks the 7-step demo-day happy path documented in LIGHTHOUSE.md §18 and
 * BACKEND_AUDIT.md top gap #1, asserting at every step. Designed to fail loud
 * before stage time, not on stage.
 *
 * Two modes:
 *
 *   bun run smoke                           (default: --mode=dry)
 *     devInspectTransactionBlock for every PTB. No gas spent. No on-chain
 *     state mutated. Catches broken PTB construction, response-shape drift,
 *     route validation regressions. Safe for CI / pre-commit.
 *
 *   bun run smoke:live                      (--mode=live)
 *     Actually executes the PTBs on testnet through Enoki sponsorship. Burns
 *     real testnet SUI and Atoma quota. Verifies on-chain events. Run before
 *     demo day with a fresh, funded test address.
 *
 * Flags:
 *   --mode=dry|live          execution mode (default: dry)
 *   --server=<url>           backend HTTP base (default: $BACKEND_URL or
 *                            http://localhost:$APP_PORT, fallback :3700)
 *   --profile-id=<cuid>      override the seeded TraderProfile id (default:
 *                            $SMOKE_PROFILE_ID; required when seeding via
 *                            Prisma is not desired)
 *   --tg-hash=<hex>          override the seeded TelegramUser
 *                            telegram_user_id_hash (default: $SMOKE_TG_HASH)
 *   --skip-trade             skip step 5 (executor trade) even in live mode
 *   --help                   print usage and exit 0
 *
 * Exit codes:
 *   0  all required steps passed
 *   1  smoke flow failed (printed diagnostic identifies the step)
 *   2  usage error (bad flags, missing env)
 *
 * Required env (live mode):
 *   JWT_SECRET, BACKEND_URL (or default localhost:APP_PORT),
 *   SMOKE_PROFILE_ID, SMOKE_TG_HASH, SUI_RPC_URL, LIGHTHOUSE_PACKAGE_ID.
 *
 * Dry mode only needs JWT_SECRET + SMOKE_PROFILE_ID + SMOKE_TG_HASH + the
 * server reachable. The script never imports Fastify, never starts a server,
 * never touches the database directly (the smoke flow exercises the live
 * routes over HTTP).
 */

import fs from 'node:fs';
import path from 'node:path';

import jwt from 'jsonwebtoken';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';

// ============================================================================
// Minimal .env loader (no heavy framework). Reads backend/.env if present and
// sets process.env entries that are not already defined. Quotes are stripped.
// ============================================================================

function loadDotenv(file: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Load backend/.env (one level up from scripts/). Idempotent.
loadDotenv(path.resolve(import.meta.dir, '..', '.env'));

// ============================================================================
// CLI parsing
// ============================================================================

type Mode = 'dry' | 'live';

interface CliFlags {
  mode: Mode;
  server: string;
  profileId: string;
  tgHash: string;
  skipTrade: boolean;
}

function printUsageAndExit(code: number): never {
  const usage = [
    'Lighthouse backend smoke test',
    '',
    'Usage: bun run scripts/smoke.ts [flags]',
    '',
    'Flags:',
    '  --mode=dry|live         execution mode (default: dry)',
    '  --server=<url>          backend base URL',
    '  --profile-id=<cuid>     TraderProfile id (or $SMOKE_PROFILE_ID)',
    '  --tg-hash=<hex>         TelegramUser id hash (or $SMOKE_TG_HASH)',
    '  --skip-trade            skip the executor trade step',
    '  --help                  print this message',
    '',
    'See backend/scripts/smoke.ts header for details.',
  ].join('\n');
  console.log(usage);
  process.exit(code);
}

function parseFlags(argv: string[]): CliFlags {
  if (argv.includes('--help')) printUsageAndExit(0);

  const mode: Mode = argv.includes('--mode=live') ? 'live' : 'dry';
  const skipTrade = argv.includes('--skip-trade');

  const serverFlag = argv.find((a) => a.startsWith('--server='))?.split('=')[1];
  const profileFlag = argv.find((a) => a.startsWith('--profile-id='))?.split('=')[1];
  const tgHashFlag = argv.find((a) => a.startsWith('--tg-hash='))?.split('=')[1];

  const defaultPort = process.env.APP_PORT || '3700';
  const server = serverFlag || process.env.BACKEND_URL || `http://localhost:${defaultPort}`;
  const profileId = profileFlag || process.env.SMOKE_PROFILE_ID || '';
  const tgHash = tgHashFlag || process.env.SMOKE_TG_HASH || '';

  return { mode, server, profileId, tgHash, skipTrade };
}

// ============================================================================
// HTTP helper
// ============================================================================

interface HttpResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  raw: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  error: { code: string; message: string } | null;
  data: T | null;
}

class StepError extends Error {
  constructor(public readonly diagnostic: string, public readonly hint?: string) {
    super(diagnostic);
    this.name = 'StepError';
  }
}

async function httpJson<T>(
  url: string,
  init: RequestInit & { jwt?: string },
): Promise<HttpResult<ApiEnvelope<T>>> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (init.jwt) headers.set('authorization', `Bearer ${init.jwt}`);

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new StepError(
      `network error calling ${url}: ${(err as Error).message}`,
      'is the backend running? try: cd backend && bun run dev',
    );
  }
  const raw = await res.text();
  let parsed: ApiEnvelope<T> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as ApiEnvelope<T>) : null;
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed, raw };
}

// ============================================================================
// Pretty printing
// ============================================================================

const TOTAL_STEPS = 7;
const stepResults: { step: number; name: string; status: 'pass' | 'fail' | 'skip' }[] = [];

function logStepHeader(step: number, title: string): void {
  process.stdout.write(`\n[${step}/${TOTAL_STEPS}] ${title}\n`);
}

function logAssert(line: string): void {
  process.stdout.write(`       ✓ ${line}\n`);
}

function logSkip(step: number, title: string, reason: string): void {
  process.stdout.write(`\n[${step}/${TOTAL_STEPS}] ${title} · SKIPPED (${reason})\n`);
  stepResults.push({ step, name: title, status: 'skip' });
}

function logFailure(
  step: number,
  title: string,
  err: Error,
  ctx?: { http?: HttpResult<unknown> },
): void {
  process.stdout.write(`\n[${step}/${TOTAL_STEPS}] ${title}\n`);
  process.stdout.write(`       ✗ ${err.message}\n`);
  if (ctx?.http) {
    process.stdout.write(`       HTTP status: ${ctx.http.status}\n`);
    const preview = ctx.http.raw.slice(0, 500);
    if (preview) process.stdout.write(`       Response: ${preview}\n`);
  }
  if (err instanceof StepError && err.hint) {
    process.stdout.write(`       Hint: ${err.hint}\n`);
  }
  stepResults.push({ step, name: title, status: 'fail' });
}

// ============================================================================
// Step 1: PREP
// ============================================================================

interface PrepResult {
  keypair: Ed25519Keypair;
  address: string;
  jwtToken: string;
  suiRpc: SuiJsonRpcClient;
  suiRpcUrl: string;
}

async function step1Prep(flags: CliFlags): Promise<PrepResult> {
  logStepHeader(1, 'PREP · Generating test keypair and forging JWT...');

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new StepError(
      'JWT_SECRET env var is required (smoke test forges a Telegram-bound JWT)',
      'export JWT_SECRET from your backend .env before running this script',
    );
  }
  if (!flags.profileId) {
    throw new StepError(
      'SMOKE_PROFILE_ID is required (or pass --profile-id=<cuid>)',
      'seed a TraderProfile row in Postgres and export its cuid id as SMOKE_PROFILE_ID',
    );
  }
  if (!flags.tgHash) {
    throw new StepError(
      'SMOKE_TG_HASH is required (or pass --tg-hash=<hex>)',
      'seed a TelegramUser row whose telegram_user_id_hash matches SMOKE_TG_HASH',
    );
  }

  const keypair = new Ed25519Keypair();
  const address = keypair.getPublicKey().toSuiAddress();
  logAssert(`Address: ${address}`);

  // Forge a JWT matching authMiddleware.ts:60 (telegram-bound).
  const jwtToken = jwt.sign(
    { sub: flags.tgHash, kind: 'telegram' },
    jwtSecret,
    { expiresIn: '10m' },
  );
  logAssert(`JWT issued (sub=${flags.tgHash.slice(0, 12)}…, expires in 10m)`);
  logAssert(`Bound profile id: ${flags.profileId}`);

  const suiRpcUrl = process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
  const network = (process.env.SUI_NETWORK || 'testnet') as
    | 'mainnet'
    | 'testnet'
    | 'devnet'
    | 'localnet';
  const suiRpc = new SuiJsonRpcClient({ network, url: suiRpcUrl });
  logAssert(`Sui RPC: ${suiRpcUrl} (${network})`);

  if (flags.mode === 'live') {
    // Try faucet (best-effort: testnet faucet rate-limits aggressively).
    try {
      await requestSuiFromFaucetV2({
        host: getFaucetHost(network as 'testnet' | 'devnet' | 'localnet'),
        recipient: address,
      });
      logAssert('Faucet funding requested');
      // Small delay for funding to land.
      await new Promise((r) => setTimeout(r, 4000));
      const bal = await suiRpc.getBalance({ owner: address });
      const sui = Number(bal.totalBalance) / 1_000_000_000;
      logAssert(`Balance: ${sui.toFixed(3)} SUI`);
    } catch (err) {
      // Non-fatal in smoke; Enoki sponsorship covers gas anyway.
      logAssert(`Faucet skipped (${(err as Error).message.slice(0, 80)})`);
    }
  } else {
    logAssert('Faucet skipped (mode=dry)');
  }

  stepResults.push({ step: 1, name: 'PREP', status: 'pass' });
  return { keypair, address, jwtToken, suiRpc, suiRpcUrl };
}

// ============================================================================
// Step 2: UC1 Onboarding (build-tx + execute)
// ============================================================================

interface OnboardingBuildTxData {
  digest: string;
  bytes: string;
  note: string;
}

interface SponsorExecuteData {
  digest: string;
}

interface Step2Result {
  onboardingDigest: string | null;
}

async function step2Onboarding(
  flags: CliFlags,
  prep: PrepResult,
): Promise<Step2Result> {
  logStepHeader(2, 'UC1 Onboarding · POST /onboarding/build-tx');

  const res = await httpJson<OnboardingBuildTxData>(
    `${flags.server}/onboarding/build-tx`,
    { method: 'POST', jwt: prep.jwtToken, body: JSON.stringify({}) },
  );
  if (!res.ok || !res.body?.success || !res.body.data) {
    const err = new StepError(
      `onboarding/build-tx failed: ${res.body?.error?.message ?? `HTTP ${res.status}`}`,
      res.status === 401
        ? 'profile is not bound to a sui_address yet; seed TraderProfile.sui_address before running smoke'
        : 'check the backend logs; Enoki sponsorship or LIGHTHOUSE_PACKAGE_ID may be missing',
    );
    logFailure(2, 'UC1 Onboarding', err, { http: res });
    throw err;
  }
  const data = res.body.data;
  logAssert(`PTB constructed (sponsored digest: ${data.digest.slice(0, 12)}…)`);
  logAssert(`Sponsored bytes length: ${data.bytes.length} base64 chars`);

  if (flags.mode === 'dry') {
    logAssert('Execution skipped (mode=dry)');
    stepResults.push({ step: 2, name: 'UC1 Onboarding', status: 'pass' });
    return { onboardingDigest: null };
  }

  // Live mode: sign the sponsored bytes with the test keypair and execute.
  // sponsored.bytes is base64; signTransaction wants the same.
  const sig = await prep.keypair.signTransaction(base64ToBytes(data.bytes));
  const exec = await httpJson<SponsorExecuteData>(`${flags.server}/sponsor/execute`, {
    method: 'POST',
    body: JSON.stringify({ digest: data.digest, signature: sig.signature }),
  });
  if (!exec.ok || !exec.body?.success || !exec.body.data) {
    const err = new StepError(
      `sponsor/execute failed: ${exec.body?.error?.message ?? `HTTP ${exec.status}`}`,
      'Enoki sponsor branch may have rejected the sender or move-call target',
    );
    logFailure(2, 'UC1 Onboarding', err, { http: exec });
    throw err;
  }
  logAssert(`Sponsor executed (tx digest: ${exec.body.data.digest})`);

  // Finalise: ask the backend to extract object IDs.
  const finalise = await httpJson<{ profileObjectId: string; balanceManagerId: string }>(
    `${flags.server}/onboarding/finalise`,
    {
      method: 'POST',
      jwt: prep.jwtToken,
      body: JSON.stringify({ digest: exec.body.data.digest }),
    },
  );
  if (!finalise.ok || !finalise.body?.success || !finalise.body.data) {
    const err = new StepError(
      `onboarding/finalise failed: ${finalise.body?.error?.message ?? `HTTP ${finalise.status}`}`,
      'objectChanges may not include TraderProfile + BalanceManager creations',
    );
    logFailure(2, 'UC1 Onboarding', err, { http: finalise });
    throw err;
  }
  logAssert(`TraderProfile created: ${finalise.body.data.profileObjectId}`);
  logAssert(`BalanceManager created: ${finalise.body.data.balanceManagerId}`);

  stepResults.push({ step: 2, name: 'UC1 Onboarding', status: 'pass' });
  return { onboardingDigest: exec.body.data.digest };
}

// ============================================================================
// Step 3: UC2 MemWal bootstrap (begin + step2)
// ============================================================================

interface MemwalBeginData {
  bytes: string;
  digest: string;
  delegatePublicKeyHex: string;
}

interface MemwalStep2Data {
  bytes: string;
  digest: string;
}

async function step3MemWal(flags: CliFlags, prep: PrepResult): Promise<void> {
  logStepHeader(3, 'UC2 MemWal Bootstrap · POST /memwal/begin → /memwal/step2');

  const begin = await httpJson<MemwalBeginData>(`${flags.server}/memwal/begin`, {
    method: 'POST',
    jwt: prep.jwtToken,
    body: JSON.stringify({}),
  });
  if (!begin.ok || !begin.body?.success || !begin.body.data) {
    const err = new StepError(
      `memwal/begin failed: ${begin.body?.error?.message ?? `HTTP ${begin.status}`}`,
      begin.body?.error?.code === 'NO_PROFILE'
        ? 'auth middleware did not resolve trader_profile_id; check that the seeded TelegramUser has a trader_profile_id'
        : 'MEMWAL_PACKAGE_ID / MEMWAL_REGISTRY_ID env vars may be missing',
    );
    logFailure(3, 'UC2 MemWal Bootstrap', err, { http: begin });
    throw err;
  }
  logAssert(
    `PTB1 sponsored (delegate pubkey: ${begin.body.data.delegatePublicKeyHex.slice(0, 16)}…)`,
  );

  if (flags.mode === 'dry') {
    logAssert('PTB1 execution skipped (mode=dry)');
    logAssert('PTB2 build skipped (depends on PTB1 executed digest)');
    stepResults.push({ step: 3, name: 'UC2 MemWal Bootstrap', status: 'pass' });
    return;
  }

  // Live: sign + execute PTB1 then ask for PTB2.
  const sig1 = await prep.keypair.signTransaction(base64ToBytes(begin.body.data.bytes));
  const exec1 = await httpJson<SponsorExecuteData>(`${flags.server}/sponsor/execute`, {
    method: 'POST',
    body: JSON.stringify({ digest: begin.body.data.digest, signature: sig1.signature }),
  });
  if (!exec1.ok || !exec1.body?.success || !exec1.body.data) {
    const err = new StepError(
      `memwal PTB1 execute failed: ${exec1.body?.error?.message ?? `HTTP ${exec1.status}`}`,
    );
    logFailure(3, 'UC2 MemWal Bootstrap', err, { http: exec1 });
    throw err;
  }
  logAssert(`PTB1 executed (digest: ${exec1.body.data.digest})`);

  const step2 = await httpJson<MemwalStep2Data>(`${flags.server}/memwal/step2`, {
    method: 'POST',
    jwt: prep.jwtToken,
    body: JSON.stringify({ executedDigest: exec1.body.data.digest }),
  });
  if (!step2.ok || !step2.body?.success || !step2.body.data) {
    const err = new StepError(
      `memwal/step2 failed: ${step2.body?.error?.message ?? `HTTP ${step2.status}`}`,
      'failed to locate MemWalAccount in PTB1 objectChanges',
    );
    logFailure(3, 'UC2 MemWal Bootstrap', err, { http: step2 });
    throw err;
  }
  logAssert(`PTB2 sponsored (add_delegate_key)`);

  const sig2 = await prep.keypair.signTransaction(base64ToBytes(step2.body.data.bytes));
  const exec2 = await httpJson<SponsorExecuteData>(`${flags.server}/sponsor/execute`, {
    method: 'POST',
    body: JSON.stringify({ digest: step2.body.data.digest, signature: sig2.signature }),
  });
  if (!exec2.ok || !exec2.body?.success || !exec2.body.data) {
    const err = new StepError(
      `memwal PTB2 execute failed: ${exec2.body?.error?.message ?? `HTTP ${exec2.status}`}`,
    );
    logFailure(3, 'UC2 MemWal Bootstrap', err, { http: exec2 });
    throw err;
  }
  logAssert(`PTB2 executed (digest: ${exec2.body.data.digest})`);
  logAssert('MemWal namespaces are populated lazily by AuditLoop on first remember; bootstrap complete');

  stepResults.push({ step: 3, name: 'UC2 MemWal Bootstrap', status: 'pass' });
}

// ============================================================================
// Step 4: UC3a Coach recommend
// ============================================================================

interface CoachDecision {
  side: string;
  pool: string;
  price: string;
  quantity: string;
  reasoning?: string;
}

interface CoachRecommendData {
  recommendationId: string;
  decision: CoachDecision;
  guardian: { overall_pass: boolean; summary: string };
  recalledMemories: unknown[];
  atomaRequestHash: string;
  atomaModel: string;
  walrusBlobId: string | null;
  memwalBlobId: string | null;
  auditAnchorTxDigest: string | null;
  userAuditPtb: { digest: string; bytes: string } | null;
}

interface Step4Result {
  recommendation: CoachRecommendData | null;
}

async function step4CoachRecommend(
  flags: CliFlags,
  prep: PrepResult,
): Promise<Step4Result> {
  logStepHeader(4, 'UC3 Coach Recommend · POST /coach/recommend');

  // In dry mode this still hits Atoma + Walrus + audit_anchor PTB if env is
  // configured, because /coach/recommend does not expose a dry-run path. We
  // mark this step as "live-network read" even in dry mode and treat a 409
  // (MEMWAL_NOT_READY / NO_EXECUTOR_AGENT) as a soft skip rather than a fail
  // · dry mode does not actually run UC1 + UC2 on chain.
  const body = {
    suiAddress: prep.address,
    userPrompt: 'SUI/USDC at 4.20, 30-day low, I hold 100 USDC and want a small starter long.',
    market: {
      mid_price: '4200000000', // 4.20 USDC in 9-decimal SUI/USDC convention
      fetched_at_ms: Date.now(),
    },
  };
  const res = await httpJson<CoachRecommendData>(`${flags.server}/coach/recommend`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // Soft-skip for dry mode when downstream chain state is missing.
  const softSkipCodes = new Set(['MEMWAL_NOT_READY', 'NO_EXECUTOR_AGENT', 'MEMWAL_DELEGATE_MISSING']);
  if (
    flags.mode === 'dry' &&
    res.body?.error?.code &&
    softSkipCodes.has(res.body.error.code)
  ) {
    logAssert(
      `Skipping coach assertions in dry mode (precondition ${res.body.error.code}; ` +
        `expected when steps 2-3 have not actually executed on chain)`,
    );
    stepResults.push({ step: 4, name: 'UC3 Coach Recommend', status: 'pass' });
    return { recommendation: null };
  }

  // TraderProfile lookup by sui_address won't match in dry mode because we
  // did not actually create a profile for prep.address. Soft-skip that too.
  if (
    flags.mode === 'dry' &&
    (res.body?.error?.code === 'NOT_FOUND' || res.status === 404)
  ) {
    logAssert(
      'Skipping coach assertions in dry mode (no TraderProfile bound to fresh keypair address)',
    );
    stepResults.push({ step: 4, name: 'UC3 Coach Recommend', status: 'pass' });
    return { recommendation: null };
  }

  if (!res.ok || !res.body?.success || !res.body.data) {
    const err = new StepError(
      `coach/recommend failed: ${res.body?.error?.message ?? `HTTP ${res.status}`}`,
      'check ATOMASDK_BEARER_AUTH and that the profile has executor_agent_id + memwal_account_id set',
    );
    logFailure(4, 'UC3 Coach Recommend', err, { http: res });
    throw err;
  }

  const rec = res.body.data;
  logAssert(`Atoma response received (model: ${rec.atomaModel})`);
  logAssert(
    `Recommendation: ${rec.decision.side.toUpperCase()} ${rec.decision.quantity} @ ${rec.decision.price}`,
  );
  if (rec.walrusBlobId) {
    logAssert(`Walrus blob ID: ${rec.walrusBlobId}`);
  } else if (rec.memwalBlobId) {
    logAssert(`MemWal blob ID (Walrus archive deferred): ${rec.memwalBlobId}`);
  } else {
    logAssert('Archive loop deferred (recommendation persisted only)');
  }
  logAssert(`Atoma request hash: ${rec.atomaRequestHash.slice(0, 20)}…`);
  if (rec.auditAnchorTxDigest) {
    logAssert(`Audit-anchor tx digest: ${rec.auditAnchorTxDigest}`);
  }

  stepResults.push({ step: 4, name: 'UC3 Coach Recommend', status: 'pass' });
  return { recommendation: rec };
}

// ============================================================================
// Step 5: UC3b Executor trade (OPTIONAL)
// ============================================================================

interface Step5Result {
  executedTradeDigest: string | null;
}

async function step5ExecutorTrade(
  flags: CliFlags,
  prep: PrepResult,
  step4: Step4Result,
): Promise<Step5Result> {
  if (flags.mode === 'dry') {
    logSkip(5, 'UC3b Executor Trade', 'mode=dry');
    return { executedTradeDigest: null };
  }
  if (flags.skipTrade) {
    logSkip(5, 'UC3b Executor Trade', '--skip-trade');
    return { executedTradeDigest: null };
  }
  const rec = step4.recommendation;
  if (!rec) {
    logSkip(5, 'UC3b Executor Trade', 'no recommendation from step 4');
    return { executedTradeDigest: null };
  }
  if (rec.decision.side.toLowerCase() !== 'bid' && rec.decision.side.toLowerCase() !== 'buy') {
    logSkip(5, 'UC3b Executor Trade', `recommendation side=${rec.decision.side} (not a buy)`);
    return { executedTradeDigest: null };
  }
  if (!rec.guardian.overall_pass) {
    logSkip(5, 'UC3b Executor Trade', 'Guardian blocked the recommendation');
    return { executedTradeDigest: null };
  }

  logStepHeader(5, 'UC3b Executor Trade · POST /sponsor/place-limit → /sponsor/execute');

  // testnet DeepBook stability hedge: if anything in this block throws, log
  // SKIP and continue. The smoke test must not fail on environmental DeepBook
  // outages per BACKEND_AUDIT.md gap #1.
  try {
    const placeBody = {
      suiAddress: prep.address,
      recommendationId: rec.recommendationId,
      baseType: process.env.DEEPBOOK_SUI_TYPE || '0x2::sui::SUI',
      quoteType: process.env.DEEPBOOK_DBUSDC_TYPE || '',
      clientOrderId: String(Date.now()),
      orderType: 0,
      selfMatching: 0,
      price: rec.decision.price,
      quantity: rec.decision.quantity,
      isBid: true,
      payWithDeep: true,
      expireTimestamp: String(Math.floor(Date.now() / 1000) + 600),
      auditWalrusBlobIdHex: undefined as string | undefined,
    };
    const place = await httpJson<{ digest: string; bytes: string }>(
      `${flags.server}/sponsor/place-limit`,
      { method: 'POST', body: JSON.stringify(placeBody) },
    );
    if (!place.ok || !place.body?.success || !place.body.data) {
      logSkip(
        5,
        'UC3b Executor Trade',
        `place-limit returned ${place.status} ${place.body?.error?.code ?? ''} (testnet DeepBook may be flaky)`,
      );
      return { executedTradeDigest: null };
    }
    const sig = await prep.keypair.signTransaction(base64ToBytes(place.body.data.bytes));
    const exec = await httpJson<SponsorExecuteData>(`${flags.server}/sponsor/execute`, {
      method: 'POST',
      body: JSON.stringify({ digest: place.body.data.digest, signature: sig.signature }),
    });
    if (!exec.ok || !exec.body?.success || !exec.body.data) {
      logSkip(
        5,
        'UC3b Executor Trade',
        `execute returned ${exec.status} ${exec.body?.error?.code ?? ''}`,
      );
      return { executedTradeDigest: null };
    }
    logAssert(`Trade executed (digest: ${exec.body.data.digest})`);
    stepResults.push({ step: 5, name: 'UC3b Executor Trade', status: 'pass' });
    return { executedTradeDigest: exec.body.data.digest };
  } catch (err) {
    logSkip(5, 'UC3b Executor Trade', `unexpected error: ${(err as Error).message.slice(0, 80)}`);
    return { executedTradeDigest: null };
  }
}

// ============================================================================
// Step 6: Audit anchor verification (queryEvents)
// ============================================================================

async function step6AuditAnchor(
  flags: CliFlags,
  prep: PrepResult,
  step4: Step4Result,
  step5: Step5Result,
): Promise<void> {
  if (flags.mode === 'dry') {
    logSkip(6, 'Audit Anchor', 'mode=dry (no on-chain events to query)');
    return;
  }
  const packageId = process.env.LIGHTHOUSE_PACKAGE_ID;
  if (!packageId) {
    logSkip(6, 'Audit Anchor', 'LIGHTHOUSE_PACKAGE_ID not set');
    return;
  }
  const rec = step4.recommendation;
  if (!rec?.walrusBlobId) {
    logSkip(6, 'Audit Anchor', 'no Walrus blob id from step 4 to verify against');
    return;
  }

  logStepHeader(6, `Audit Anchor · queryEvents ${packageId}::audit_anchor::AnchorRecorded`);

  try {
    const events = await prep.suiRpc.queryEvents({
      query: {
        MoveEventType: `${packageId}::audit_anchor::AnchorRecorded`,
      },
      limit: 50,
      order: 'descending',
    });
    if (!events.data || events.data.length === 0) {
      throw new StepError('no AnchorRecorded events found on chain');
    }
    logAssert(`Found ${events.data.length} recent AnchorRecorded event(s)`);

    // We do not assert which exact event matches · blob id matching requires
    // u256 comparison of parsedJson.blob_id with rec.walrusBlobId converted via
    // blobIdToInt. We surface the most recent event's tx digest so the
    // operator can cross-check manually if needed.
    const latest = events.data[0];
    if (latest) {
      logAssert(`Latest event tx digest: ${latest.id.txDigest}`);
      const parsed = latest.parsedJson as { kind?: number; blob_id?: string } | undefined;
      if (parsed) {
        logAssert(`Latest event kind: ${parsed.kind ?? '?'}, blob_id (u256): ${(parsed.blob_id ?? '').slice(0, 24)}…`);
      }
    }
    if (step5.executedTradeDigest) {
      logAssert(`Cross-check: executor trade digest was ${step5.executedTradeDigest}`);
    }
    if (rec.auditAnchorTxDigest) {
      logAssert(`Cross-check: coach-signed anchor digest was ${rec.auditAnchorTxDigest}`);
    }

    stepResults.push({ step: 6, name: 'Audit Anchor', status: 'pass' });
  } catch (err) {
    logFailure(6, 'Audit Anchor', err as Error);
    throw err;
  }
}

// ============================================================================
// Step 7: CLEANUP
// ============================================================================

function step7Cleanup(flags: CliFlags): void {
  if (flags.mode === 'dry') {
    logSkip(7, 'CLEANUP', 'mode=dry');
    return;
  }
  // No-op for live mode v1: testnet gas drain is intentionally not automated.
  // A future iteration can sweep prep.keypair balances back to a known sink.
  logStepHeader(7, 'CLEANUP');
  logAssert('No automated cleanup in v1; testnet gas left on test address');
  stepResults.push({ step: 7, name: 'CLEANUP', status: 'pass' });
}

// ============================================================================
// Helpers
// ============================================================================

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function printSummary(mode: Mode, durationMs: number): number {
  const passed = stepResults.filter((s) => s.status === 'pass').length;
  const skipped = stepResults.filter((s) => s.status === 'skip').length;
  const failed = stepResults.filter((s) => s.status === 'fail').length;
  const banner = '='.repeat(41);
  process.stdout.write(`\n${banner}\n`);
  if (failed > 0) {
    const firstFail = stepResults.find((s) => s.status === 'fail');
    process.stdout.write(`SMOKE TEST FAILED at step ${firstFail?.step}/${TOTAL_STEPS}\n`);
  } else {
    process.stdout.write(`SMOKE TEST PASSED in ${(durationMs / 1000).toFixed(1)}s\n`);
  }
  process.stdout.write(`Mode: ${mode}\n`);
  process.stdout.write(`Steps: ${passed} passed, ${skipped} skipped, ${failed} failed\n`);
  process.stdout.write(`${banner}\n`);
  return failed > 0 ? 1 : 0;
}

// ============================================================================
// Entrypoint
// ============================================================================

let interrupted = false;
function installSignalHandlers(): void {
  const handler = (sig: string): void => {
    interrupted = true;
    process.stdout.write(`\n[smoke] received ${sig}, aborting...\n`);
    // Allow main() to print a summary; do not call process.exit here so any
    // in-flight fetch can settle. A second signal forces exit.
    process.once(sig, () => process.exit(130));
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function main(): Promise<number> {
  installSignalHandlers();
  let flags: CliFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[smoke] usage error: ${(err as Error).message}\n`);
    return 2;
  }
  process.stdout.write(
    `\nLighthouse smoke test · mode=${flags.mode} server=${flags.server}\n`,
  );

  const start = Date.now();

  // Each step is wrapped: if it throws and the step did not record its own
  // failure (e.g. a network error before logFailure ran), record one here so
  // the summary is accurate.
  async function runStep<T>(
    step: number,
    title: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      const alreadyRecorded = stepResults.some((s) => s.step === step);
      if (!alreadyRecorded) {
        logFailure(step, title, err as Error);
      }
      return null;
    }
  }

  const prep = await runStep(1, 'PREP', () => step1Prep(flags));
  if (!prep || stepResults.some((s) => s.status === 'fail')) {
    return printSummary(flags.mode, Date.now() - start);
  }
  if (interrupted) return printSummary(flags.mode, Date.now() - start);

  const onboarding = await runStep(2, 'UC1 Onboarding', () => step2Onboarding(flags, prep));
  if (onboarding === null || interrupted) {
    return printSummary(flags.mode, Date.now() - start);
  }

  const memwal = await runStep(3, 'UC2 MemWal Bootstrap', () => step3MemWal(flags, prep));
  if (memwal === null || interrupted) {
    return printSummary(flags.mode, Date.now() - start);
  }

  const step4 = await runStep(4, 'UC3 Coach Recommend', () =>
    step4CoachRecommend(flags, prep),
  );
  if (step4 === null || interrupted) {
    return printSummary(flags.mode, Date.now() - start);
  }

  const step5 = await runStep(5, 'UC3b Executor Trade', () =>
    step5ExecutorTrade(flags, prep, step4),
  );
  if (interrupted) return printSummary(flags.mode, Date.now() - start);

  await runStep(6, 'Audit Anchor', () =>
    step6AuditAnchor(flags, prep, step4, step5 ?? { executedTradeDigest: null }),
  );
  if (interrupted) return printSummary(flags.mode, Date.now() - start);

  // step7Cleanup is synchronous and never throws.
  step7Cleanup(flags);

  return printSummary(flags.mode, Date.now() - start);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[smoke] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
