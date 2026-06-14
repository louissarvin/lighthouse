/**
 * scripts/setup-telegram-bot.ts
 *
 * One-shot, idempotent Telegram bot configuration push.
 *
 * Performs seven Bot API calls in sequence to bring the live bot's identity,
 * command menu, menu button, and webhook in line with what Lighthouse's
 * backend expects. Re-runnable: every `setMy*` and `setChatMenuButton` call
 * is "set-state, no-op on equal input" semantics from Telegram's side, and
 * `setWebhook` is safe to repeat with the same URL + secret.
 *
 * Source of truth for copy + the 9-command set:
 *   memory/research/LIGHTHOUSE_TELEGRAM_BOT_SETUP.md sections 3, 4, 5.
 *
 * Bot API references (verified):
 *   https://core.telegram.org/bots/api#getme
 *   https://core.telegram.org/bots/api#setmyname
 *   https://core.telegram.org/bots/api#setmyshortdescription
 *   https://core.telegram.org/bots/api#setmydescription
 *   https://core.telegram.org/bots/api#setmycommands
 *   https://core.telegram.org/bots/api#setchatmenubutton
 *   https://core.telegram.org/bots/api#setwebhook
 *   https://core.telegram.org/bots/api#setmyprofilephoto (Bot API 9.4, 2026-02)
 *
 * Modes:
 *
 *   bun run setup-bot              (push to Telegram)
 *     Executes every required mutation. Exits 0 if all required steps pass,
 *     1 if any required step failed.
 *
 *   bun run setup-bot:dry          (--dry-run)
 *     Prints the planned config for every step without calling the Bot API.
 *     Useful for verifying copy + URLs before committing to a live push.
 *
 * Flags:
 *   --dry-run                no Bot API calls; print the plan only
 *   --verbose                print the raw Bot API response per call (truncated)
 *   --help                   print usage and exit 0
 *
 * Exit codes:
 *   0  all required steps passed (or dry-run completed with no env errors)
 *   1  at least one required step failed
 *   2  usage error (bad flags, missing TELEGRAM_BOT_TOKEN)
 *
 * Env vars consumed:
 *   TELEGRAM_BOT_TOKEN              (required) bot token from BotFather
 *   TELEGRAM_WEBHOOK_SECRET_TOKEN   (optional) gate for /tg/webhook
 *   PUBLIC_BASE_URL                 (optional) e.g. https://api.lighthouse.example.com
 *   LIGHTHOUSE_MINI_APP_URL         (optional) e.g. https://lighthouse.wal.app
 *
 * Step 7 (setWebhook) is skipped with a clear message when PUBLIC_BASE_URL
 * or TELEGRAM_WEBHOOK_SECRET_TOKEN is missing. Step 6 (setChatMenuButton)
 * falls back to `{ type: 'commands' }` when LIGHTHOUSE_MINI_APP_URL is unset.
 *
 * Hard rules:
 *   - Token + secret token are NEVER printed at any verbosity.
 *   - Per-step failures do not halt the script; the summary reports them.
 *   - Uses the shared `bot.api.*` grammY wrapper, never raw fetch.
 *
 * IMPORTANT: this script imports the running backend's bot instance, which
 * makes any required env validation in main-config.ts fire on import. If you
 * see a FATAL on missing DATABASE_URL etc., it is the config module, not the
 * setup script. Run with the same .env you use for the API server.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Bot, InputFile, type BotCommand, type MenuButton } from 'grammy';

import { getTelegramBot } from '../src/lib/telegramBot.ts';
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET_TOKEN,
} from '../src/config/main-config.ts';

// ============================================================================
// Constants (copy from research §3 + §4; do not improvise)
// ============================================================================

const BOT_NAME = 'Lighthouse Coach';

const BOT_SHORT_DESCRIPTION =
  'Verifiable AI trading coach. Cross-session memory on Walrus. Built on Sui.';

/// Long description. Walrus Site URL line is conditionally included when
/// LIGHTHOUSE_MINI_APP_URL is set so the published description gracefully
/// omits a broken link in environments where the Mini App is not yet live.
function buildLongDescription(miniAppUrl: string | undefined): string {
  const base =
    'Lighthouse is a verifiable AI trading coach for Sui DeFi. ' +
    'Your risk profile and trade history live on Walrus, encrypted with SEAL, ' +
    'and follow you across Telegram, web, and any future agent you authorise. ' +
    'Coach recommendations run on Atoma decentralised inference. ' +
    'Trades settle through DeepBook v3 inside an on-chain budget you set and can ' +
    'revoke in one tap.';
  return miniAppUrl ? `${base} Web app: ${miniAppUrl}` : base;
}

/// The 9-command set locked in research §3. Order matters: Telegram clients
/// render the first ~8 cleanly above the fold, so /start through /tearsheet
/// are the primary discovery surface and /revoke sits at the bottom as the
/// safety lever.
const COMMANDS: BotCommand[] = [
  { command: 'start',     description: 'Sign in and bind your Sui address' },
  { command: 'help',      description: 'List all commands and docs link' },
  { command: 'profile',   description: 'Show your trader profile and risk slice' },
  { command: 'budget',    description: 'View executor agent budget and expiry' },
  { command: 'trades',    description: 'Last 10 trades (status, side, qty, price)' },
  { command: 'balance',   description: 'DeepBook BalanceManager balances' },
  { command: 'pnl',       description: 'Running weekly P&L summary' },
  { command: 'tearsheet', description: 'Public weekly tearsheet URL' },
  { command: 'revoke',    description: 'Revoke ExecutorAgent, MemWal key, or session' },
  { command: 'anchor',    description: 'Anchor a note to Walrus with on-chain proof' },
  { command: 'trade',     description: 'Place a DeepBook order via ExecutorAgent' },
  { command: 'predict',   description: 'DeepBook Predict markets (paused pending DUSDC)' },
];

// TODO: avatar PNG must be 640x640 or 1024x1024, under 5MB, RGB. The Bot API
// type `InputProfilePhotoStatic` requires JPG in spec wording but accepts the
// usual image types in practice; if you have a transparent PNG, flatten it
// against #0d1117 (Lighthouse dark) and export as JPG to be safe.
const AVATAR_PATH = path.resolve(import.meta.dir, 'assets', 'lighthouse-bot-avatar.png');

const TOTAL_STEPS = 7; // 8 if avatar is present; printed dynamically.

// ============================================================================
// Minimal .env loader (matches smoke.ts behaviour). Reads backend/.env if
// present and sets process.env entries that are not already defined.
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

loadDotenv(path.resolve(import.meta.dir, '..', '.env'));

// ============================================================================
// CLI parsing
// ============================================================================

interface CliFlags {
  dryRun: boolean;
  verbose: boolean;
}

function printUsageAndExit(code: number): never {
  const usage = [
    'Lighthouse Telegram bot setup',
    '',
    'Usage: bun run scripts/setup-telegram-bot.ts [flags]',
    '',
    'Flags:',
    '  --dry-run    print the planned config without calling the Bot API',
    '  --verbose    print the raw Bot API response per call (truncated)',
    '  --help       print this message',
    '',
    'Env vars: TELEGRAM_BOT_TOKEN (required), TELEGRAM_WEBHOOK_SECRET_TOKEN,',
    '          PUBLIC_BASE_URL, LIGHTHOUSE_MINI_APP_URL (all optional).',
  ].join('\n');
  process.stdout.write(`${usage}\n`);
  process.exit(code);
}

function parseFlags(argv: string[]): CliFlags {
  if (argv.includes('--help')) printUsageAndExit(0);
  return {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
  };
}

// ============================================================================
// Pretty printing (mirrors smoke.ts)
// ============================================================================

type StepStatus = 'pass' | 'fail' | 'skip';

interface StepResult {
  step: number;
  name: string;
  status: StepStatus;
  required: boolean;
}

const stepResults: StepResult[] = [];

function totalStepsForRun(): number {
  return fs.existsSync(AVATAR_PATH) ? TOTAL_STEPS + 1 : TOTAL_STEPS;
}

function logHeader(step: number, title: string): void {
  process.stdout.write(`\n[${step}/${totalStepsForRun()}] ${title}\n`);
}

function logAssert(line: string): void {
  process.stdout.write(`       ✓ ${line}\n`);
}

function logInfo(line: string): void {
  process.stdout.write(`       · ${line}\n`);
}

function logSkipLine(line: string): void {
  process.stdout.write(`       · ${line}\n`);
}

function recordPass(step: number, name: string, required: boolean): void {
  stepResults.push({ step, name, status: 'pass', required });
}

function recordSkip(step: number, name: string, required: boolean, reason: string): void {
  process.stdout.write(`       · SKIPPED: ${reason}\n`);
  stepResults.push({ step, name, status: 'skip', required });
}

function recordFail(
  step: number,
  name: string,
  required: boolean,
  err: unknown,
  hint?: string,
): void {
  const e = err as { message?: string; description?: string; error_code?: number };
  const code = e?.error_code !== undefined ? `HTTP ${e.error_code}` : 'error';
  const apiMessage = e?.description ?? e?.message ?? String(err);
  process.stdout.write(`       ✗ ${code}\n`);
  process.stdout.write(`       Telegram API error: ${truncate(apiMessage, 300)}\n`);
  if (hint) process.stdout.write(`       Hint: ${hint}\n`);
  stepResults.push({ step, name, status: 'fail', required });
}

function logRaw(label: string, value: unknown, verbose: boolean): void {
  if (!verbose) return;
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  process.stdout.write(`       [verbose] ${label}: ${truncate(str, 200)}\n`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// ============================================================================
// Step runners
// ============================================================================

/// We deliberately do NOT use the shared TelegramBotHandle from
/// src/lib/telegramBot.ts for the Bot API calls themselves, because the shared
/// instance has command handlers + the message:text fallback registered. The
/// setup script does not consume updates and does not need handlers; using a
/// fresh `Bot(TOKEN)` avoids any side-effect risk. We still call
/// getTelegramBot() once below to surface the same "disabled stub" warning the
/// running server emits, keeping operator UX consistent.
type SetupApi = InstanceType<typeof Bot>['api'];

function makeSetupBot(): SetupApi {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  return bot.api;
}

interface RunContext {
  api: SetupApi;
  flags: CliFlags;
  miniAppUrl: string | undefined;
  publicBaseUrl: string | undefined;
}

async function step1GetMe(ctx: RunContext): Promise<void> {
  logHeader(1, 'getMe · verifying bot token...');
  if (ctx.flags.dryRun) {
    logInfo('would call bot.api.getMe()');
    recordPass(1, 'getMe', true);
    return;
  }
  try {
    const me = await ctx.api.getMe();
    logAssert(`Bot username: @${me.username}`);
    logAssert(`Bot ID: ${me.id}`);
    logAssert('Token valid');
    logRaw('response', { id: me.id, username: me.username, is_bot: me.is_bot }, ctx.flags.verbose);
    recordPass(1, 'getMe', true);
  } catch (err) {
    recordFail(1, 'getMe', true, err, 'check TELEGRAM_BOT_TOKEN is current; rotate via BotFather /token if revoked');
  }
}

async function step2SetMyName(ctx: RunContext): Promise<void> {
  logHeader(2, `setMyName · "${BOT_NAME}"...`);
  if (ctx.flags.dryRun) {
    logInfo(`would set name to "${BOT_NAME}" (${BOT_NAME.length}/64 chars)`);
    recordPass(2, 'setMyName', true);
    return;
  }
  try {
    const res = await ctx.api.setMyName(BOT_NAME);
    logAssert('Updated');
    logRaw('response', res, ctx.flags.verbose);
    recordPass(2, 'setMyName', true);
  } catch (err) {
    recordFail(2, 'setMyName', true, err, 'name must be 1..64 chars');
  }
}

async function step3SetMyShortDescription(ctx: RunContext): Promise<void> {
  const len = BOT_SHORT_DESCRIPTION.length;
  logHeader(3, `setMyShortDescription · ${len} chars...`);
  if (ctx.flags.dryRun) {
    logInfo(`would set short description (${len}/120 chars):`);
    logInfo(`"${BOT_SHORT_DESCRIPTION}"`);
    recordPass(3, 'setMyShortDescription', true);
    return;
  }
  try {
    const res = await ctx.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
    logAssert('Updated');
    logRaw('response', res, ctx.flags.verbose);
    recordPass(3, 'setMyShortDescription', true);
  } catch (err) {
    recordFail(3, 'setMyShortDescription', true, err, 'short description max 120 chars');
  }
}

async function step4SetMyDescription(ctx: RunContext): Promise<void> {
  const description = buildLongDescription(ctx.miniAppUrl);
  const len = description.length;
  const withMiniApp = ctx.miniAppUrl ? ' (with Mini App URL)' : ' (without Mini App URL)';
  logHeader(4, `setMyDescription · ${len} chars${withMiniApp}...`);
  if (ctx.flags.dryRun) {
    logInfo(`would set long description (${len}/512 chars):`);
    logInfo(`"${description}"`);
    recordPass(4, 'setMyDescription', true);
    return;
  }
  try {
    const res = await ctx.api.setMyDescription(description);
    logAssert('Updated');
    logRaw('response', res, ctx.flags.verbose);
    recordPass(4, 'setMyDescription', true);
  } catch (err) {
    recordFail(4, 'setMyDescription', true, err, 'long description max 512 chars');
  }
}

async function step5SetMyCommands(ctx: RunContext): Promise<void> {
  logHeader(5, `setMyCommands · ${COMMANDS.length} commands...`);
  if (ctx.flags.dryRun) {
    for (const c of COMMANDS) {
      logInfo(`/${c.command}: ${c.description}`);
    }
    logInfo(`would push ${COMMANDS.length} commands at scope: default`);
    recordPass(5, 'setMyCommands', true);
    return;
  }
  try {
    // grammY 1.30 signature: setMyCommands(commands, other?, signal?)
    // where `other` accepts { scope?, language_code? }.
    const res = await ctx.api.setMyCommands(COMMANDS, {
      scope: { type: 'default' },
    });
    for (const c of COMMANDS) {
      logAssert(`/${c.command}: ${c.description}`);
    }
    logAssert(`Pushed ${COMMANDS.length} commands at scope: default`);
    logRaw('response', res, ctx.flags.verbose);
    recordPass(5, 'setMyCommands', true);
  } catch (err) {
    recordFail(
      5,
      'setMyCommands',
      true,
      err,
      'command names must match /^[a-z][a-z0-9_]{0,31}$/; descriptions max 256 chars',
    );
  }
}

async function step6SetChatMenuButton(ctx: RunContext): Promise<void> {
  const menu_button: MenuButton = ctx.miniAppUrl
    ? { type: 'web_app', text: 'Open Lighthouse', web_app: { url: ctx.miniAppUrl } }
    : { type: 'commands' };
  const summary = ctx.miniAppUrl
    ? `web_app: ${ctx.miniAppUrl}`
    : 'commands (no LIGHTHOUSE_MINI_APP_URL set)';
  logHeader(6, `setChatMenuButton · ${summary}...`);
  if (ctx.flags.dryRun) {
    logInfo(`would set default menu button to: ${JSON.stringify(menu_button)}`);
    recordPass(6, 'setChatMenuButton', true);
    return;
  }
  try {
    // chat_id omitted = default menu button (applies to all private chats
    // that haven't been overridden per-chat). grammY wraps the optional
    // chat_id + menu_button into a single options object.
    const res = await ctx.api.setChatMenuButton({ menu_button });
    if (menu_button.type === 'web_app') {
      logAssert(`Updated to Mini App at ${menu_button.web_app.url}`);
    } else {
      logAssert('Updated to commands (slash-commands menu)');
    }
    logRaw('response', res, ctx.flags.verbose);
    recordPass(6, 'setChatMenuButton', true);
  } catch (err) {
    recordFail(
      6,
      'setChatMenuButton',
      true,
      err,
      'web_app.url must be HTTPS; menu button text 1..256 chars',
    );
  }
}

async function step7SetWebhook(ctx: RunContext): Promise<void> {
  const baseLabel = ctx.publicBaseUrl ?? '<unset>';
  const url = ctx.publicBaseUrl ? `${ctx.publicBaseUrl}/tg/webhook` : '<skip>';
  logHeader(7, `setWebhook · ${url}...`);

  if (!ctx.publicBaseUrl || !TELEGRAM_WEBHOOK_SECRET_TOKEN) {
    const missing: string[] = [];
    if (!ctx.publicBaseUrl) missing.push('PUBLIC_BASE_URL');
    if (!TELEGRAM_WEBHOOK_SECRET_TOKEN) missing.push('TELEGRAM_WEBHOOK_SECRET_TOKEN');
    recordSkip(
      7,
      'setWebhook',
      false,
      `set ${missing.join(' and ')} to apply (base=${baseLabel})`,
    );
    return;
  }

  if (ctx.flags.dryRun) {
    logInfo(`would register webhook URL: ${url}`);
    logInfo('would attach secret token (value redacted)');
    logInfo('would set allowed_updates: ["message","callback_query"]');
    logInfo('would set drop_pending_updates: true');
    recordPass(7, 'setWebhook', true);
    return;
  }

  try {
    const res = await ctx.api.setWebhook(url, {
      secret_token: TELEGRAM_WEBHOOK_SECRET_TOKEN,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    logAssert('Webhook URL registered');
    logAssert('Secret token applied');
    logAssert('allowed_updates: message, callback_query');
    logAssert('drop_pending_updates: true');
    // Do NOT log the secret token in verbose mode. Log only the boolean res.
    logRaw('response', res, ctx.flags.verbose);
    recordPass(7, 'setWebhook', true);
  } catch (err) {
    recordFail(
      7,
      'setWebhook',
      true,
      err,
      'webhook URL must be HTTPS reachable from Telegram; check secret token charset (A-Z a-z 0-9 _ -, 1..256 chars)',
    );
  }
}

async function step8OptionalAvatar(ctx: RunContext, stepNumber: number): Promise<void> {
  const exists = fs.existsSync(AVATAR_PATH);
  logHeader(stepNumber, 'setMyProfilePhoto · optional avatar...');
  if (!exists) {
    recordSkip(
      stepNumber,
      'setMyProfilePhoto',
      false,
      `no avatar file at scripts/assets/lighthouse-bot-avatar.png (Bot API 9.4 method; supply a JPG static photo, 640x640 or 1024x1024, under 5MB, RGB)`,
    );
    return;
  }
  if (ctx.flags.dryRun) {
    logInfo(`would upload avatar from ${AVATAR_PATH}`);
    recordPass(stepNumber, 'setMyProfilePhoto', false);
    return;
  }
  try {
    const res = await ctx.api.setMyProfilePhoto({
      type: 'static',
      photo: new InputFile(AVATAR_PATH),
    });
    logAssert(`Avatar uploaded from ${path.basename(AVATAR_PATH)}`);
    logRaw('response', res, ctx.flags.verbose);
    recordPass(stepNumber, 'setMyProfilePhoto', false);
  } catch (err) {
    // Optional step: a failure does not flip the overall exit code, but it
    // is still reported as a fail in the summary line so operators see it.
    recordFail(
      stepNumber,
      'setMyProfilePhoto',
      false,
      err,
      'profile photo must be JPG, 640x640 or 1024x1024, under 5MB',
    );
  }
}

// ============================================================================
// Summary
// ============================================================================

function printSummary(durationMs: number): number {
  const passed = stepResults.filter((s) => s.status === 'pass').length;
  const skipped = stepResults.filter((s) => s.status === 'skip').length;
  const failed = stepResults.filter((s) => s.status === 'fail').length;
  const requiredFailures = stepResults.filter((s) => s.status === 'fail' && s.required);

  const banner = '='.repeat(41);
  process.stdout.write(`\n${banner}\n`);
  if (requiredFailures.length > 0) {
    const first = requiredFailures[0];
    process.stdout.write(`SETUP FAILED at step ${first?.step}/${totalStepsForRun()}\n`);
  } else {
    process.stdout.write(`SETUP COMPLETE in ${(durationMs / 1000).toFixed(1)}s\n`);
  }
  process.stdout.write(`Steps: ${passed} passed, ${skipped} skipped, ${failed} failed\n`);
  process.stdout.write(`${banner}\n`);

  if (requiredFailures.length === 0) {
    process.stdout.write('\nManual verification:\n');
    process.stdout.write('  - Open the bot in Telegram (use the @username printed in step 1)\n');
    process.stdout.write('  - Type "/" to verify the 9 commands appear in the menu\n');
    process.stdout.write(
      '  - Tap the menu button to verify it opens the Mini App (or shows commands menu)\n',
    );
    process.stdout.write('  - Open the bot profile page to verify the name + description\n');
  }

  return requiredFailures.length > 0 ? 1 : 0;
}

// ============================================================================
// Entrypoint
// ============================================================================

let interrupted = false;
function installSignalHandlers(): void {
  const handler = (sig: string): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write(`\n[setup-bot] received ${sig}, aborting after current step...\n`);
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
    process.stderr.write(`[setup-bot] usage error: ${(err as Error).message}\n`);
    return 2;
  }

  if (!TELEGRAM_BOT_TOKEN) {
    process.stderr.write(
      '[setup-bot] TELEGRAM_BOT_TOKEN is required. Export it from BotFather and retry.\n',
    );
    return 2;
  }

  const miniAppUrl = process.env.LIGHTHOUSE_MINI_APP_URL || undefined;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || undefined;

  process.stdout.write(
    `\nLighthouse Telegram bot setup · ${flags.dryRun ? 'dry-run' : 'apply'}` +
      `${flags.verbose ? ' (verbose)' : ''}\n`,
  );
  process.stdout.write(`  PUBLIC_BASE_URL:         ${publicBaseUrl ?? '<unset>'}\n`);
  process.stdout.write(`  LIGHTHOUSE_MINI_APP_URL: ${miniAppUrl ?? '<unset>'}\n`);
  process.stdout.write(
    `  TELEGRAM_WEBHOOK_SECRET: ${TELEGRAM_WEBHOOK_SECRET_TOKEN ? '<set>' : '<unset>'}\n`,
  );

  // Surface the same warning the running server would emit if the bot were
  // disabled. We do NOT use the shared bot handle for API calls (see comment
  // on makeSetupBot), but we still call getTelegramBot() once so any boot-time
  // log message is consistent with `bun run dev`.
  getTelegramBot();

  const api = makeSetupBot();
  const ctx: RunContext = {
    api,
    flags,
    miniAppUrl,
    publicBaseUrl,
  };

  const start = Date.now();

  // Each step records its own pass/fail. We do not throw out of these
  // functions; per-step errors are reported and the run continues so
  // operators see the full picture.
  await step1GetMe(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step2SetMyName(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step3SetMyShortDescription(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step4SetMyDescription(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step5SetMyCommands(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step6SetChatMenuButton(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  await step7SetWebhook(ctx);
  if (interrupted) return printSummary(Date.now() - start);

  // Optional step 8: avatar. Only renders if the asset file exists.
  if (fs.existsSync(AVATAR_PATH)) {
    await step8OptionalAvatar(ctx, 8);
  }

  return printSummary(Date.now() - start);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Catastrophic failure outside any step. Print a concise diagnostic so
    // the operator can correlate with the last header line printed above.
    process.stderr.write(`[setup-bot] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
