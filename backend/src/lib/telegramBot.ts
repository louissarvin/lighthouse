/**
 * Telegram bot (grammY).
 *
 * Source: https://grammy.dev/ (v1.43+, Bun-compatible)
 *
 * Lighthouse uses WEBHOOK mode for production (per LIGHTHOUSE.md §15.2d) so
 * the Fastify server handles HTTP POSTs from Telegram and dispatches them to
 * the bot's update handler. Long-polling is supported for local dev too.
 *
 * Commands (§15.3):
 *   /start [payload]  — onboard or resume; handles OAuth return via startPayload
 *   /help             — list commands + docs link
 *   /profile          — risk profile summary
 *   /budget           — current budget + remaining
 *   /trades           — last 10 trades
 *   /balance          — DeepBook balance manager balances
 *   /pnl              — running weekly P&L (24h-fresh)
 *   /tearsheet        — public weekly tearsheet URL
 *   /revoke           — interactive revocation menu
 *   <text>            — forwarded to coach
 *
 * If `TELEGRAM_BOT_TOKEN` is not set we return a disabled stub so the backend
 * keeps booting (matches messaging.ts pattern).
 */

import { Bot, type Context, InlineKeyboard, webhookCallback } from 'grammy';

import {
  ATOMA_DEFAULT_MODEL,
  TELEGRAM_BOT_TOKEN,
  PREDICT_OBJECT_ID,
  PREDICT_SERVER_URL,
  SUI_RPC_URL,
  DUSDC_TYPE_TAG,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { chatCreate, type ChatMessage } from './atoma.ts';
import { anchorText } from './coachAnchor.ts';
import { buildPlaceLimitTx, buildDepositTx } from './deepbook.ts';
import { getActiveMarkets, getPredictManagerDusdcBalance, getWalletBalances } from './predict.ts';
import { getAllManagerBalances, getSuiDbusdcMidPrice } from './deepbookQueries.ts';
import { envelopeDecrypt } from './envelope.ts';
import { getExecutorKeypair } from './keypairs.ts';
import { analyzeAndRemember, rememberBulk, recallAll, NAMESPACES } from './memwal.ts';
import { getCachedExecutorAgent } from './onChainAgent.ts';
import { SETUP_QUESTION_PROMPTS } from './setupQuestions.ts';
import { suiGrpc, suiRpc } from './sui.ts';
import { hashTelegramUserId } from './telegram.ts';
import { buildTelegramOAuthFlow } from './zklogin.ts';
import { nanoid } from 'nanoid';
import {
  DEEPBOOK_SUI_DBUSDC_POOL,
  DEEPBOOK_DBUSDC_TYPE,
} from '../config/main-config.ts';

const SUI_TYPE_TAG_DEP =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

/// In-memory map: messageId → text to be anchored if the user clicks the
/// "💾 Save & Anchor" button. Bounded so a long-running bot does not leak.
/// Telegram messageIds are unique per chat, so we key on `${chatId}:${msgId}`.
/// TTL not strictly enforced — the eviction is FIFO via Map insertion order.
const PENDING_ANCHORS = new Map<string, string>();
const MAX_PENDING_ANCHORS = 500;

function rememberPendingAnchor(chatId: number, msgId: number, text: string): void {
  if (PENDING_ANCHORS.size >= MAX_PENDING_ANCHORS) {
    // Drop oldest. Map preserves insertion order; .keys().next() = oldest.
    const oldest = PENDING_ANCHORS.keys().next().value;
    if (oldest) PENDING_ANCHORS.delete(oldest);
  }
  PENDING_ANCHORS.set(`${chatId}:${msgId}`, text);
}

function takePendingAnchor(chatId: number, msgId: number): string | undefined {
  const key = `${chatId}:${msgId}`;
  const v = PENDING_ANCHORS.get(key);
  if (v !== undefined) PENDING_ANCHORS.delete(key);
  return v;
}

// =============================================================================
// /setup — UC1 Risk Profile Onboarding state machine
// =============================================================================

interface SetupSession {
  step: number;
  answers: string[];
  expiresAt: number;
}

const setupSessions = new Map<number, SetupSession>();
const SETUP_TTL_MS = 10 * 60 * 1000;

// Re-aliased from the shared module so the Telegram bot and the web
// onboarding wizard (GET /onboarding/risk-questions) stay in lockstep.
// Edit prompts in src/lib/setupQuestions.ts — NOT here.
const SETUP_QUESTIONS = SETUP_QUESTION_PROMPTS;

/**
 * Format a Sui address as `0x12345678…abcdef` for readability in Telegram
 * messages where long hex strings wrap awkwardly. The full address is
 * separately included in code blocks via the caller.
 */
function shortAddr(addr: string): string {
  if (!addr || addr.length < 14) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

/**
 * Strip markdown markers from LLM output so Telegram renders cleanly even
 * if the model ignores the "plain text only" instruction in the system
 * prompt. Conservative: removes bold/italic markers, header hashes, code
 * fences. Preserves inline code (backticks) since Telegram understands
 * them and they look fine.
 */
function stripMarkdown(s: string): string {
  return s
    // Remove triple-backtick code fences (keep inner text)
    .replace(/```(?:\w+)?\n?/g, '')
    // Remove ** and __ pairs (bold)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // Remove leftover lone asterisks at word boundaries (italic + bullets)
    .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$|[.,!?:;])/g, '$1$2')
    // Remove leading # from header lines
    .replace(/^\s*#{1,6}\s+/gm, '')
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Standard "what to try next" hint for users post-onboarding. Surfaces the
 * functioning bot features. /trade and /predict show up too — backend
 * signs trades via ExecutorAgent, so zero user gas + zero user signatures.
 */
const NEXT_STEPS_HINT =
  '*What to try next:*\n' +
  '• `/predict` — place a BTC binary option (gas-free, Google sign-in)\n' +
  '• `/positions` — check your open and won predictions\n' +
  '• Send any message — AI coach replies with a 💾 *Save & Anchor* button\n' +
  '• `/trade sell SUI 0.05 @5.00` — place a real DeepBook limit order\n' +
  '• `/profile` — full account dashboard\n' +
  '• `/help` — complete command reference';

/// grammY's `webhookCallback` returns a union of adapter shapes. We always
/// use the `'std/http'` adapter which is `(req: Request) => Promise<Response>`.
export type WebhookHandler = (req: Request) => Promise<Response>;

export interface TelegramBotHandle {
  enabled: boolean;
  /// Returns the grammY webhook handler for Fastify integration.
  webhookHandler(): WebhookHandler | null;
  /// Send a plain-text message to a Telegram chat id (DM).
  sendMessage(chatId: number, text: string): Promise<void>;
  /// Start long-polling (dev only). NOT used in production webhook flow.
  startPolling(): Promise<void>;
  /// Stop long-polling cleanly.
  stop(): Promise<void>;
}

let _bot: TelegramBotHandle | null = null;

export function getTelegramBot(): TelegramBotHandle {
  if (_bot) return _bot;
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn(
      '[telegram-bot] TELEGRAM_BOT_TOKEN is not set — bot is DISABLED. ' +
        'Set TELEGRAM_BOT_TOKEN to enable commands + DMs.',
    );
    const stub = makeDisabledStub();
    _bot = stub;
    return stub;
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  registerHandlers(bot);

  // grammY locks the bot into webhook OR polling mode at the first call —
  // calling `webhookCallback` AND `bot.start()` raises. We defer creating the
  // webhook handler until it's actually requested, so dev (polling) and prod
  // (webhook) modes are mutually exclusive at runtime.
  let cachedHandler: WebhookHandler | null = null;
  let pollingStarted = false;

  const handle: TelegramBotHandle = {
    enabled: true,
    webhookHandler: () => {
      if (pollingStarted) {
        console.warn('[telegram-bot] polling already started; cannot serve webhook');
        return null;
      }
      if (!cachedHandler) {
        cachedHandler = webhookCallback(bot, 'std/http') as unknown as WebhookHandler;
      }
      return cachedHandler;
    },
    async sendMessage(chatId, text) {
      await bot.api.sendMessage(chatId, text);
    },
    async startPolling() {
      if (cachedHandler) {
        throw new Error(
          '[telegram-bot] webhook handler already initialised; cannot also start polling. ' +
            'Set TG_BOT_POLLING=0 to use webhook mode.',
        );
      }
      console.log('[telegram-bot] starting long-polling');
      pollingStarted = true;
      await bot.start();
    },
    async stop() {
      console.log('[telegram-bot] stopping');
      await bot.stop();
    },
  };
  _bot = handle;
  return handle;
}

// =============================================================================
// Command handlers
// =============================================================================

function registerHandlers(bot: Bot): void {
  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('profile', profileCommand);
  bot.command('budget', budgetCommand);
  bot.command('trades', tradesCommand);
  bot.command('balance', balanceCommand);
  bot.command('pnl', pnlCommand);
  bot.command('tearsheet', tearsheetCommand);
  bot.command('revoke', revokeCommand);
  bot.command('logout', logoutCommand);
  bot.command('anchor', anchorCommand);
  bot.command('trade', tradeCommand);
  bot.command('deposit', depositCommand);
  bot.command('sweep', sweepCommand);
  bot.command('topup', topupCommand);
  bot.command('predict', predictCommand);
  bot.command('positions', positionsCommand);
  bot.command('setup', setupCommand);
  bot.command('memwal', memwalCommand);
  // setup-trading: manual fallback if the OAuth-callback auto-setup failed.
  // Requires the user's JWT to still be fresh — i.e. ran within ~1h of the
  // most recent /start sign-in.
  bot.command(['setup_trading', 'setup-trading', 'setuptrading'], async (ctx) => {
    await ctx.reply(
      'Trading state is auto-bootstrapped during the OAuth callback (right ' +
        'after you tap *Sign in with Google* in /start).\n\n' +
        'If you see "⏳ Trading not yet set up" in /start, run /start again ' +
        'to redo the OAuth flow — the trading setup will run inline.',
      { parse_mode: 'Markdown' },
    );
  });

  // Inline keyboard callbacks for /revoke menu.
  bot.callbackQuery('revoke:agent', revokeAgentCallback);
  bot.callbackQuery('revoke:memwal', revokeMemwalCallback);
  bot.callbackQuery('revoke:session', revokeSessionCallback);
  bot.callbackQuery('revoke:cancel', revokeCancelCallback);

  // Logout callbacks: confirm clears telegram_chat_id (soft logout, preserves
  // TelegramUser + TraderProfile rows for audit and asset safety).
  bot.callbackQuery(/^logout:/, logoutCallback);

  // Coach reply anchor: when the user taps "💾 Save & Anchor" on a coach
  // message, upload the reply to Walrus + emit an on-chain AuditAnchor.
  // Backed by the Coach keypair (no user signature required).
  bot.callbackQuery('coach:anchor', coachAnchorCallback);

  // Trade confirm/cancel callbacks — payload includes pending-trade id.
  bot.callbackQuery(/^trade:confirm:/, tradeConfirmCallback);
  bot.callbackQuery(/^trade:cancel:/, tradeCancelCallback);
  bot.callbackQuery(/^pred:/, predictActionCallback);

  // Predict callbacks: phase-1 setup balance check + phase-2 OAuth-signed mint.
  bot.callbackQuery(/^prd:setup:/, predictSetupCheckCallback);

  // Deposit callbacks: balance check (phase 1) and executor confirm (phase 2).
  bot.callbackQuery(/^dep:check:/, depositCheckCallback);
  bot.callbackQuery(/^dep:confirm:/, depositConfirmCallback);

  // Help quick-action shortcuts — just forward to the matching command handler.
  bot.callbackQuery('help:predict',   async (ctx) => { await ctx.answerCallbackQuery(); await predictCommand(ctx); });
  bot.callbackQuery('help:positions', async (ctx) => { await ctx.answerCallbackQuery(); await positionsCommand(ctx); });
  bot.callbackQuery('help:balance',   async (ctx) => { await ctx.answerCallbackQuery(); await balanceCommand(ctx); });
  bot.callbackQuery('help:profile',   async (ctx) => { await ctx.answerCallbackQuery(); await profileCommand(ctx); });
  bot.callbackQuery('help:trade',     async (ctx) => { await ctx.answerCallbackQuery(); await tradeCommand(ctx); });
  bot.callbackQuery('help:memwal',    async (ctx) => { await ctx.answerCallbackQuery(); await memwalCommand(ctx); });

  // Fallback: forward any non-command text to the coach.
  bot.on('message:text', coachForward);

  // Defensive error capture; never let an exception kill the bot.
  bot.catch((err) => {
    console.error('[telegram-bot] handler error:', err.error);
  });

  // Register command list with Telegram so the / menu is populated.
  void bot.api.setMyCommands([
    { command: 'start',      description: 'Onboard or resume your account' },
    { command: 'help',       description: 'Show all commands and features' },
    { command: 'profile',    description: 'Account dashboard — address, status, modules' },
    { command: 'predict',    description: 'BTC binary option markets (place a bet)' },
    { command: 'positions',  description: 'Open, won, lost and redeemed predictions' },
    { command: 'balance',    description: 'DeepBook BalanceManager balances' },
    { command: 'budget',     description: 'Per-trade and daily trading limits' },
    { command: 'trades',     description: 'Last 10 DeepBook limit orders' },
    { command: 'pnl',        description: 'Prediction win rate and P&L summary' },
    { command: 'setup',      description: 'Personalize your risk profile (5 questions)' },
    { command: 'memwal',     description: 'Set up encrypted coach memory on Walrus' },
    { command: 'tearsheet',  description: 'Public weekly performance tearsheet URL' },
    { command: 'anchor',     description: 'Pin text to Walrus with an on-chain proof' },
    { command: 'trade',      description: 'Place a DeepBook limit order' },
    { command: 'deposit',    description: 'Deposit SUI into your BalanceManager' },
    { command: 'sweep',      description: 'Move SUI from your wallet to your BalanceManager' },
    { command: 'topup',      description: 'Top up DUSDC to your PredictManager' },
    { command: 'revoke',     description: 'Revoke an agent, key, or session' },
    { command: 'logout',     description: 'Disconnect this telegram from your Sui address (assets stay safe)' },
  ]).catch((e: unknown) => console.warn('[bot] setMyCommands failed:', (e as Error).message));
}

async function startCommand(ctx: Context): Promise<void> {
  if (!ctx.from?.id) return;
  const tgHash = hashTelegramUserId(ctx.from.id);

  // Bind the raw chat id so the dispatcher can DM later.
  // Idempotent: only sets if a TelegramUser row exists for this hash.
  if (ctx.chat?.id) {
    await prismaQuery.telegramUser.updateMany({
      where: { telegram_user_id_hash: tgHash },
      data: {
        telegram_chat_id: BigInt(ctx.chat.id),
        telegram_username: ctx.from.username ?? null,
      },
    });
  }

  // Handle OAuth return payload: `/start zklogin_done_<nonce>`
  const payload = (ctx as Context & { startPayload?: string }).startPayload;
  if (payload && payload.startsWith('zklogin_done_')) {
    const nonce = payload.replace('zklogin_done_', '');
    const binding = await prismaQuery.oAuthNonce.findUnique({ where: { nonce } });
    if (binding && binding.telegram_user_id_hash === tgHash) {
      if (!binding.consumed_at) {
        // Rare: user returned before callback finished consuming the nonce.
        await ctx.reply(
          `✅ *zkLogin completed.* Sui address bound.\n\n` + NEXT_STEPS_HINT,
          { parse_mode: 'Markdown' },
        );
        return;
      }
      // Nonce already consumed — action completed. Show action-specific reply.
      const action = binding.action ?? 'onboard';
      if (action === 'predict_mint') {
        await ctx.reply(
          `🎯 *Prediction confirmed!*\n\nYour binary position is live on-chain.\n\nUse /predict to place another or track your positions.`,
          { parse_mode: 'Markdown' },
        );
        return;
      }
      if (action === 'predict_setup') {
        await ctx.reply(
          `✅ *Predict account ready!*\n\nYour PredictManager is funded with DUSDC.\n\nUse /predict to see live BTC markets.`,
          { parse_mode: 'Markdown' },
        );
        return;
      }
      if (action === 'deposit') {
        await ctx.reply(
          `✅ *Deposit confirmed!*\n\nYour SUI has been deposited into your BalanceManager.\n\nUse /balance to check your balance.`,
          { parse_mode: 'Markdown' },
        );
        return;
      }
      // 'onboard' or unknown — show standard success and fall through to welcome back.
      await ctx.reply(
        `✅ *zkLogin completed.* Sui address bound.\n\n` + NEXT_STEPS_HINT,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    // Could not find or verify nonce — might be an old link. Just show welcome.
    // Don't show an error — it's confusing when nonces expire legitimately.
    // Fall through to standard welcome flow below.
  }

  const user = await prismaQuery.telegramUser.findUnique({
    where: { telegram_user_id_hash: tgHash },
    include: { trader_profile: true },
  });

  if (user) {
    const p = user.trader_profile;
    const hasBm = !!p.balance_manager_id;
    const hasAgent = !!p.executor_agent_id;
    const tradingReady = hasBm && hasAgent;

    if (tradingReady) {
      const bmExplorer = `https://suiscan.xyz/testnet/object/${p.balance_manager_id}`;
      const agentExplorer = `https://suiscan.xyz/testnet/object/${p.executor_agent_id}`;
      // Standard returning-user flow.
      await ctx.reply(
        `*Welcome back.*\n\n` +
          `*Bound address:*\n\`${p.sui_address}\`\n\n` +
          `✅ *Trading enabled*\n\n` +
          `*BalanceManager:*\n\`${p.balance_manager_id}\`\n` +
          `[View BM ↗](${bmExplorer})\n\n` +
          `*ExecutorAgent:*\n\`${p.executor_agent_id}\`\n` +
          `[View Agent ↗](${agentExplorer})\n\n` +
          NEXT_STEPS_HINT + '\n\n' +
          `Send me a message any time. Use /help for commands.`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
      );
      return;
    }

    // Trading not set up: re-auth to trigger the OAuth-callback setup
    // bootstrap. Generate a fresh OAuth nonce + URL.
    let oauthUrl: string | null = null;
    try {
      const flow = await buildTelegramOAuthFlow(tgHash);
      oauthUrl = flow.oauthUrl;
    } catch (e) {
      console.warn('[bot/start] re-auth flow build failed:', (e as Error).message);
    }

    if (oauthUrl) {
      const kb = new InlineKeyboard().url(
        '🔐 Sign in with Google (enables trading)',
        oauthUrl,
      );
      await ctx.reply(
        `*Welcome back.*\n\n` +
          `Bound address: \`${shortAddr(p.sui_address)}\`\n` +
          `Full: \`${p.sui_address}\`\n\n` +
          `⏳ Trading isn't set up yet for this account.\n\n` +
          `Tap the button below to re-authenticate. The OAuth callback will:\n` +
          `  1. Drip 0.1 SUI to your address (Coach pays)\n` +
          `  2. Create a BalanceManager + ExecutorAgent owned by you\n` +
          `  3. Deposit the SUI into the BalanceManager\n` +
          `All in one sponsored PTB. Zero gas from you.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } else {
      await ctx.reply(
        `*Welcome back.*\n\n` +
          `Bound address: \`${shortAddr(p.sui_address)}\`\n\n` +
          `⏳ Trading not set up + couldn't generate sign-in URL. ` +
          `Check that GOOGLE_CLIENT_ID is set in env.`,
        { parse_mode: 'Markdown' },
      );
    }
    return;
  }

  // Server-driven OAuth flow for new users. Generates a per-user Google
  // sign-in URL bound to a 5-min zkLogin nonce. After the user completes
  // Google OAuth, /oauth/callback redirects them back to this bot via
  // `t.me/<bot>?start=zklogin_done_<nonce>` which the payload handler
  // above picks up.
  let oauthUrl: string | null = null;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash);
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    console.warn('[telegram-bot] OAuth flow build failed:', (e as Error).message);
  }

  if (oauthUrl) {
    const kb = new InlineKeyboard().url('🔐 Sign in with Google', oauthUrl);
    await ctx.reply(
      '*Welcome to Lighthouse.*\n\n' +
        'I am a verifiable AI trading coach. Your risk profile and trade ' +
        'history live on Walrus, encrypted with SEAL, signed by you via ' +
        'zkLogin.\n\n' +
        'Tap the button below to sign in with Google. It is a one-tap ' +
        'flow — no seed phrase, no password. After Google, you will be ' +
        'sent back to this chat automatically.',
      { parse_mode: 'Markdown', reply_markup: kb },
    );
  } else {
    await ctx.reply(
      'Welcome to *Lighthouse*.\n\n' +
        'I am a verifiable AI trading coach, but my Google sign-in is not ' +
        'configured yet. Ask the operator to set `GOOGLE_CLIENT_ID` and ' +
        'restart the backend, then try `/start` again.',
      { parse_mode: 'Markdown' },
    );
  }
}

async function helpCommand(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text('🎯 Predict Markets', 'help:predict')
    .text('📊 My Positions', 'help:positions')
    .row()
    .text('💰 Balance', 'help:balance')
    .text('👤 Profile', 'help:profile')
    .row()
    .text('📈 Place Trade', 'help:trade')
    .text('🧠 Coach Memory', 'help:memwal');

  await ctx.reply(
    `*Lighthouse — Command Reference*\n\n` +
    `━━━ 🎯 *Predict* ━━━\n` +
    `/predict — Live BTC binary option markets\n` +
    `/positions — Open, won, lost & claimed bets\n` +
    `/topup <amount> — Top up DUSDC into your PredictManager (for predictions)\n` +
    `/pnl — Win rate & prediction P&L\n\n` +
    `━━━ 🏦 *Trading* ━━━\n` +
    `/trade — Place a DeepBook limit order\n` +
    `/deposit — Fund your BalanceManager with SUI\n` +
    `/sweep — Move SUI from your wallet to BalanceManager\n` +
    `/balance — BalanceManager coin balances\n` +
    `/budget — Per-trade & daily spending limits\n` +
    `/trades — Last 10 limit orders\n\n` +
    `━━━ 👤 *Account* ━━━\n` +
    `/profile — Full account dashboard\n` +
    `/setup — Personalize risk profile (5 Qs)\n` +
    `/memwal — Encrypted coach memory on Walrus\n` +
    `/tearsheet — Public weekly performance URL\n\n` +
    `━━━ 🔧 *Tools* ━━━\n` +
    `/anchor — Pin text to Walrus + on-chain proof\n` +
    `/revoke — Revoke agent / key / session\n` +
    `/logout — Disconnect this telegram from your Sui address (assets stay safe)\n` +
    `/start — Re-onboard or refresh auth\n\n` +
    `💬 *Any other message* → forwarded to AI coach\n` +
    `Every coach reply has a 💾 *Save & Anchor* button to record the advice on-chain.\n\n` +
    `_Testnet · Gas sponsored · Zero seed phrases_`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function profileCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;

  const addr = profile.sui_address;
  const shortAddress = `${addr.slice(0, 10)}…${addr.slice(-6)}`;
  const explorerUrl = `https://suiscan.xyz/testnet/account/${addr}`;
  const memberSince = profile.created_at.toISOString().slice(0, 10);

  const bm  = profile.balance_manager_id  ? `✅ \`${profile.balance_manager_id.slice(0, 12)}…\``  : '❌ Not set up';
  const ag  = profile.executor_agent_id   ? `✅ \`${profile.executor_agent_id.slice(0, 12)}…\``   : '❌ Not set up';
  const pm  = profile.predict_manager_id  ? `✅ \`${profile.predict_manager_id.slice(0, 12)}…\``  : '❌ Not set up';
  const mw  = profile.memwal_account_id   ? `✅ \`${profile.memwal_account_id.slice(0, 12)}…\``   : '❌ Not set up';
  const ns  = profile.suins_name          ? `✅ ${profile.suins_name}.sui`                         : '—';

  // Aggregate predict stats
  const [wonCount, lostCount, openCount] = await Promise.all([
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'settled',  deleted_at: null } }),
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'lost',     deleted_at: null } }),
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'open',     deleted_at: null } }),
  ]);
  const totalSettled = wonCount + lostCount;
  const winRate = totalSettled > 0 ? `${Math.round((wonCount / totalSettled) * 100)}%` : '—';

  const kb = new InlineKeyboard()
    .url('🔍 Explorer', explorerUrl)
    .row()
    .text('🎯 Predict', 'help:predict')
    .text('💰 Balance', 'help:balance')
    .row()
    .text('🧠 Coach Memory', 'help:memwal');

  await ctx.reply(
    `*Account Dashboard*\n\n` +
    `👤 *Address*\n\`${shortAddress}\`\n\`${addr}\`\n\n` +
    `🗓 Member since: ${memberSince}\n` +
    `🌐 SuiNS: ${ns}\n\n` +
    `━━━ *Module Status* ━━━\n` +
    `🏦 BalanceManager: ${bm}\n` +
    `🤖 ExecutorAgent:  ${ag}\n` +
    `🎯 PredictManager: ${pm}\n` +
    `🧠 Coach Memory:   ${mw}\n\n` +
    `━━━ *Predict Stats* ━━━\n` +
    `🟢 Open positions: ${openCount}\n` +
    `🏆 Won: ${wonCount}  ❌ Lost: ${lostCount}\n` +
    `📊 Win rate: ${winRate}`,
    { parse_mode: 'Markdown', reply_markup: kb, link_preview_options: { is_disabled: true } },
  );
}

async function budgetCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;
  if (!profile.executor_agent_id) {
    await ctx.reply(
      `⚙️ *No ExecutorAgent found*\n\n` +
      `Run /start to complete account setup — the OAuth callback creates your BalanceManager and ExecutorAgent automatically. Zero gas, one tap.\n\n` +
      `Once set up, /budget shows per-trade and daily spending limits.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  try {
    const a = await getCachedExecutorAgent(profile.id, profile.executor_agent_id);
    const spentToday   = Number(a.spent_today);
    const maxDay       = Number(a.max_notional_per_day);
    const remaining    = maxDay - spentToday;
    const pctUsed      = maxDay > 0 ? Math.round((spentToday / maxDay) * 100) : 0;
    const barFilled    = Math.round(pctUsed / 10);
    const bar          = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled);
    const expiresAt    = new Date(Number(a.expires_at_ms));
    const expiresStr   = expiresAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const status       = a.revoked ? '🔴 REVOKED' : '🟢 Active';

    await ctx.reply(
      `*Trading Budget*\n\n` +
      `Status: ${status}\n\n` +
      `━━━ *Limits* ━━━\n` +
      `Per-trade cap:  ${a.max_notional_per_trade.toString()} units\n` +
      `Daily cap:      ${a.max_notional_per_day.toString()} units\n\n` +
      `━━━ *Today's Usage* ━━━\n` +
      `Spent:     ${spentToday} units\n` +
      `Remaining: ${remaining} units\n` +
      `\`[${bar}] ${pctUsed}%\`\n\n` +
      `Agent expires: ${expiresStr}\n` +
      `Allowed pools: ${a.allowed_pools.length}\n\n` +
      `Use /revoke to revoke this agent at any time.`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    await ctx.reply(`❌ Budget fetch failed: ${(e as Error).message}`);
  }
}

async function tradesCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;
  const trades = await prismaQuery.trade.findMany({
    where: { trader_profile_id: profile.id, deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: 10,
  });
  if (!trades.length) {
    await ctx.reply(
      `📋 *No trades yet*\n\n` +
      `Use /trade to place your first DeepBook limit order.\n` +
      `Example: \`/trade sell SUI 0.05 @5.00\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const lines = trades.map((t, i) => {
    const num    = (i + 1).toString().padStart(2);
    const side   = t.side.toLowerCase() === 'buy' ? '📈 BUY ' : '📉 SELL';
    const status =
      t.status === 'filled'    ? '✅' :
      t.status === 'cancelled' ? '❌' :
      t.status === 'partial'   ? '🔄' : '⏳';
    const qty    = t.quantity.toString().padStart(8);
    const price  = t.price.toString().padStart(8);
    return `${num}. ${status} ${side} ${qty} @ ${price}`;
  });
  await ctx.reply(
    `*Last ${trades.length} trades*\n\n` +
    `\`#   S  Side   Qty        Price\`\n` +
    `\`${lines.join('\n')}\`\n\n` +
    `Legend: ✅ filled  ⏳ pending  🔄 partial  ❌ cancelled`,
    { parse_mode: 'Markdown' },
  );
}

async function positionsCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;

  const positions = await prismaQuery.hedgePosition.findMany({
    where: { trader_profile_id: profile.id, deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: 20,
  });

  if (positions.length === 0) {
    await ctx.reply(
      '📊 *Your Positions*\n\nNo predict positions yet. Use /predict to place your first bet.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const tgHash = ctx.from?.id ? hashTelegramUserId(ctx.from.id) : '';

  const open = positions.filter((p) => p.status === 'open');
  const settled = positions.filter((p) => p.status === 'settled');   // won — claim available
  const lost = positions.filter((p) => p.status === 'lost');         // lost — no claim
  const redeemed = positions.filter((p) => p.status === 'redeemed');

  let text = '📊 *Your Predict Positions*\n\n';

  if (open.length > 0) {
    text += `*Active (${open.length})*\n`;
    for (const pos of open) {
      const dir = pos.is_up ? '📈 UP' : '📉 DOWN';
      const strikeUsd = (Number(pos.strike) / 1e9).toFixed(2);
      const qty = (Number(pos.quantity) / 1_000_000).toFixed(0);
      const expiryMs = pos.expiry_ms ? Number(pos.expiry_ms) : null;
      const minsLeft = expiryMs
        ? Math.max(0, Math.round((expiryMs - Date.now()) / 60000))
        : null;
      const timeTag =
        minsLeft !== null
          ? minsLeft > 0
            ? ` · ${minsLeft}m left`
            : ' · expired, settling...'
          : '';
      text += `${dir} BTC @ $${strikeUsd} · ${qty} DUSDC payout${timeTag}\n`;
    }
    text += '\n';
  }

  const claimLinks: { label: string; url: string }[] = [];

  if (settled.length > 0) {
    text += `*Won — Claim Available (${settled.length})*\n`;
    for (const pos of settled) {
      const dir = pos.is_up ? '📈 UP' : '📉 DOWN';
      const strikeUsd = (Number(pos.strike) / 1e9).toFixed(2);
      const qty = (Number(pos.quantity) / 1_000_000).toFixed(0);
      text += `🎉 ${dir} BTC @ $${strikeUsd} · ${qty} DUSDC payout — claim below\n`;

      if (tgHash && pos.predict_id) {
        try {
          const flow = await buildTelegramOAuthFlow(tgHash, {
            action: 'predict_redeem',
            ttlMs: 30 * 60 * 1000,
            action_meta: {
              traderProfileId: pos.trader_profile_id,
              predictObjectId: pos.predict_id,
              oracleObjectId: pos.oracle_id,
              oracleInitialSharedVersion: 0, // resolved lazily in redeemPredictViaZkLogin
              // '0' is a sentinel for old rows with null expiry_ms.
              // redeemPredictViaZkLogin detects 0n and fetches the value
              // lazily from the oracle's on-chain `expiry` field.
              expiryMs: pos.expiry_ms?.toString() ?? '0',
              strike: pos.strike.toString(),
              isUp: pos.is_up,
              quantity: pos.quantity.toString(),
            },
          });
          claimLinks.push({
            label: `💰 Claim ${dir} @ $${strikeUsd}`,
            url: flow.oauthUrl,
          });
        } catch (e) {
          console.warn('[positions] claim link build failed:', (e as Error).message);
        }
      }
    }
    text += '\n';
  }

  if (lost.length > 0) {
    text += `*Expired — Lost (${lost.length})*\n`;
    for (const pos of lost.slice(0, 5)) {
      const dir = pos.is_up ? '📈 UP' : '📉 DOWN';
      const strikeUsd = (Number(pos.strike) / 1e9).toFixed(2);
      const qty = (Number(pos.quantity) / 1_000_000).toFixed(0);
      text += `❌ ${dir} BTC @ $${strikeUsd} · ${qty} DUSDC payout\n`;
    }
    if (lost.length > 5) text += `_…and ${lost.length - 5} more_\n`;
    text += '\n';
  }

  if (redeemed.length > 0) {
    text += `*Redeemed (${redeemed.length})*\n`;
    for (const pos of redeemed.slice(0, 5)) {
      const dir = pos.is_up ? '📈 UP' : '📉 DOWN';
      const strikeUsd = (Number(pos.strike) / 1e9).toFixed(2);
      const qty = (Number(pos.quantity) / 1_000_000).toFixed(0);
      text += `✅ ${dir} BTC @ $${strikeUsd} · ${qty} DUSDC payout claimed\n`;
    }
    if (redeemed.length > 5) text += `_…and ${redeemed.length - 5} more_\n`;
    text += '\n';
  }

  const totalPositions = open.length + settled.length + lost.length + redeemed.length;
  const allTimeWon     = settled.length + redeemed.length;
  const allTimeLost    = lost.length;
  const totalSettled   = allTimeWon + allTimeLost;
  const winRateSummary = totalSettled > 0
    ? `${Math.round((allTimeWon / totalSettled) * 100)}% win rate (${allTimeWon}W / ${allTimeLost}L)`
    : 'No settled positions yet';

  text +=
    `━━━ *Summary* ━━━\n` +
    `${winRateSummary}\n` +
    `_Total tracked: ${totalPositions} · Use /predict to place new bets_`;

  if (claimLinks.length > 0) {
    const kb = new InlineKeyboard();
    for (const link of claimLinks) {
      kb.url(link.label, link.url).row();
    }
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}

// =============================================================================
// /setup implementation
// =============================================================================

async function setupCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const profile = await loadProfile(ctx);
  if (!profile) return;

  setupSessions.set(chatId, { step: 0, answers: [], expiresAt: Date.now() + SETUP_TTL_MS });

  await ctx.reply(
    `🎯 *Risk Profile Setup* (5 questions)\n\n` +
      `I'll ask you 5 quick questions so I can coach you better. ` +
      `Your answers are stored in your encrypted MemWal account — only you can recall them.\n\n` +
      `Type /cancel at any time to exit.\n\n` +
      SETUP_QUESTIONS[0],
    { parse_mode: 'Markdown' },
  );
}

async function handleSetupAnswer(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const session = setupSessions.get(chatId);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    setupSessions.delete(chatId);
    return false;
  }

  // Skip command messages (starts with /) — let them pass through.
  if (text.startsWith('/')) return false;

  session.answers.push(text.trim());
  const nextStep = session.step + 1;

  if (nextStep < SETUP_QUESTIONS.length) {
    session.step = nextStep;
    await ctx.reply(SETUP_QUESTIONS[nextStep], { parse_mode: 'Markdown' });
    return true;
  }

  // All 5 answers collected.
  setupSessions.delete(chatId);

  const profile = await loadProfile(ctx);
  if (!profile) {
    await ctx.reply('Setup complete! (MemWal write skipped — profile not found.)');
    return true;
  }

  const [goal, timeHorizon, maxDrawdown, markets, leverageView] = session.answers;

  const bulkItems = [
    { text: `Trading goal: ${goal}`, namespace: NAMESPACES.goals },
    { text: `Time horizon: ${timeHorizon}`, namespace: NAMESPACES.riskProfile },
    { text: `Maximum acceptable drawdown: ${maxDrawdown}`, namespace: NAMESPACES.riskProfile },
    { text: `Preferred markets: ${markets}`, namespace: NAMESPACES.preferences },
    { text: `Leverage and binary outcome stance: ${leverageView}`, namespace: NAMESPACES.riskProfile },
    {
      text:
        `Full onboarding profile completed ${new Date().toISOString()}: ` +
        `goal="${goal}" horizon="${timeHorizon}" drawdown="${maxDrawdown}" ` +
        `markets="${markets}" leverage="${leverageView}"`,
      namespace: NAMESPACES.riskProfile,
    },
  ];

  let memwalOk = false;
  if (profile.memwal_account_id && profile.memwal_delegate_key_encrypted) {
    try {
      const delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
      const account = { delegateKey, accountId: profile.memwal_account_id };
      await rememberBulk(account, bulkItems);
      memwalOk = true;
    } catch (e) {
      console.warn('[setup] rememberBulk failed:', (e as Error).message);
    }
  }

  // Set the completion flag unconditionally — matches the new web endpoint
  // (POST /onboarding/risk-profile/complete). The user has answered all 5
  // questions; the MemWal write is best-effort and can be retried later, but
  // the gating timestamp should not depend on it.
  try {
    await prismaQuery.traderProfile.update({
      where: { id: profile.id },
      data: { risk_profile_completed_at: new Date() },
    });
  } catch (e) {
    console.warn('[setup] risk_profile_completed_at update failed:', (e as Error).message);
  }

  await ctx.reply(
    `✅ *Risk Profile Saved!*\n\n` +
      `Here's what I now know about you:\n\n` +
      `🎯 *Goal:* ${goal}\n` +
      `⏱ *Horizon:* ${timeHorizon}\n` +
      `📉 *Max drawdown:* ${maxDrawdown}\n` +
      `🏦 *Markets:* ${markets}\n` +
      `⚡ *Leverage stance:* ${leverageView}\n\n` +
      (memwalOk
        ? `📚 Stored in your MemWal account. The coach will reference this in every conversation.\n\n`
        : `⚠️ Coach memory not set up yet — answers noted but not persisted. Run /memwal to enable persistent memory, then /setup again.\n\n`) +
      `Run /setup any time to update your profile.`,
    { parse_mode: 'Markdown' },
  );

  return true;
}

// =============================================================================
// /memwal — UC1 MemWal account bootstrap via OAuth
// =============================================================================
//
// Generates a Google OAuth link with action='memwal_setup'. The callback
// executes two sponsored PTBs (create_account + add_delegate_key) using the
// user's zkLogin credentials, then persists memwal_account_id to the DB.
//
// Zero gas for the user — both PTBs are Enoki-sponsored.

async function memwalCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;

  if (profile.memwal_account_id) {
    await ctx.reply(
      `🧠 *Coach memory is already active*\n\n` +
        `MemWal account: \`${profile.memwal_account_id.slice(0, 14)}…\`\n\n` +
        `Every conversation is remembered across sessions. ` +
        `Run /setup to update your risk profile.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const tgHash = ctx.from?.id ? hashTelegramUserId(ctx.from.id) : null;
  if (!tgHash) {
    await ctx.reply('Could not identify your Telegram user. Try /start first.');
    return;
  }

  // MemWal's create_account is not on Enoki's sponsorship allowlist, so we
  // use the coach keypair as gas payer with the user's zkLogin address as
  // sender. This still needs a Google OAuth round-trip to get the JWT +
  // zkLogin state for signing. The callback executes both PTBs automatically.
  let oauthUrl: string;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash, {
      action: 'memwal_setup',
      ttlMs: 10 * 60 * 1000,
    });
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    await ctx.reply(`Failed to build OAuth link: ${(e as Error).message}`);
    return;
  }

  await ctx.reply(
    `🧠 *Set up Coach Memory*\n\n` +
      `This creates your encrypted memory account on Walrus so the coach ` +
      `remembers your goals, trades, and lessons across every session.\n\n` +
      `Two transactions run automatically — *coach pays all gas, zero cost to you.*\n\n` +
      `1. Tap the link below and sign in with Google\n` +
      `2. Both transactions execute in the background\n` +
      `3. Return here — you'll get a confirmation DM\n\n` +
      `👉 [Activate Coach Memory](${oauthUrl})\n\n` +
      `_Link expires in 10 minutes._`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
  );
}

async function balanceCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;

  const loadingMsg = await ctx.reply('⏳ Fetching all balances...');

  // ── Run all three balance sources in parallel ──────────────────────────
  const [bmBalances, pmBalance, walletBalance] = await Promise.all([
    // 1. DeepBook BalanceManager (SUI + DBUSDC for trading)
    profile.balance_manager_id
      ? getAllManagerBalances(profile.balance_manager_id).catch(() => [])
      : Promise.resolve([]),

    // 2. PredictManager internal DUSDC + open positions count
    profile.predict_manager_id
      ? getPredictManagerDusdcBalance(SUI_RPC_URL, profile.predict_manager_id).catch(
          () => ({ dusdcRaw: 0n, positionCount: 0 }),
        )
      : Promise.resolve({ dusdcRaw: 0n, positionCount: 0 }),

    // 3. Wallet coins at sui_address (SUI + DUSDC held directly)
    getWalletBalances(SUI_RPC_URL, profile.sui_address, DUSDC_TYPE_TAG).catch(
      () => ({ suiRaw: 0n, dusdcRaw: 0n }),
    ),
  ]);

  // ── Format helper ─────────────────────────────────────────────────────
  const fmtSui   = (raw: bigint) => (Number(raw) / 1e9).toFixed(6);
  const fmtDusdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(6);

  // ── Section 1: BalanceManager ─────────────────────────────────────────
  let text = `💼 *Full Balance Overview*\n\n`;

  if (profile.balance_manager_id) {
    const bmUrl = `https://suiscan.xyz/testnet/object/${profile.balance_manager_id}`;
    text += `━━━ 🏦 *BalanceManager* ━━━\n`;
    text += `[${profile.balance_manager_id}](${bmUrl})\n`;
    if (bmBalances.length === 0) {
      text += `_No balances found_\n`;
    } else {
      for (const b of bmBalances) {
        const label = b.coin.padEnd(8);
        // `getManagerBalance` (DeepBook SDK `checkManagerBalance`) returns a
        // HUMAN-DECIMAL string (e.g. "2.1" SUI, "100.5" DBUSDC) — NOT raw MIST.
        // Previously this code was wrapping it in BigInt and dividing by 1e9
        // again, so a real BM balance of 2.1 SUI displayed as 0.000000.
        const human = Number(b.balance);
        const val = Number.isFinite(human) ? human.toFixed(6) : '0.000000';
        text += `  ${label}  ${val}\n`;
      }
    }
    text += `_DeepBook trading account_\n\n`;
  } else {
    text += `━━━ 🏦 *BalanceManager* ━━━\n❌ Not set up — run /start\n\n`;
  }

  // ── Section 2: PredictManager ─────────────────────────────────────────
  if (profile.predict_manager_id) {
    const pmUrl   = `https://suiscan.xyz/testnet/object/${profile.predict_manager_id}`;
    const pmDusdc = fmtDusdc(pmBalance.dusdcRaw);
    text += `━━━ 🎯 *PredictManager* ━━━\n`;
    text += `[${profile.predict_manager_id}](${pmUrl})\n`;
    text += `  DUSDC     ${pmDusdc}\n`;
    if (pmBalance.positionCount > 0) {
      text += `  Positions  ${pmBalance.positionCount} open on-chain\n`;
    }
    text += `_Available to bet · use /predict_\n\n`;
  } else {
    text += `━━━ 🎯 *PredictManager* ━━━\n❌ Not set up — use /predict to create\n\n`;
  }

  // ── Section 3: Wallet ─────────────────────────────────────────────────
  const walletUrl = `https://suiscan.xyz/testnet/account/${profile.sui_address}`;
  text += `━━━ 👛 *Wallet* ━━━\n`;
  text += `[${profile.sui_address}](${walletUrl})\n`;
  text += `  SUI       ${fmtSui(walletBalance.suiRaw)}\n`;
  if (walletBalance.dusdcRaw > 0n) {
    text += `  DUSDC     ${fmtDusdc(walletBalance.dusdcRaw)}\n`;
  }
  text += `_zkLogin address · gas sponsored_\n`;

  // ── Inline keyboard ───────────────────────────────────────────────────
  const kb = new InlineKeyboard();
  if (profile.balance_manager_id) {
    kb.url('🏦 BM Explorer', `https://suiscan.xyz/testnet/object/${profile.balance_manager_id}`);
  }
  if (profile.predict_manager_id) {
    kb.url('🎯 PM Explorer', `https://suiscan.xyz/testnet/object/${profile.predict_manager_id}`);
  }
  kb.row().url('👛 Wallet Explorer', `https://suiscan.xyz/testnet/account/${profile.sui_address}`);

  // Delete the "Fetching..." message and send the full result
  try {
    await ctx.api.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id);
  } catch { /* ignore if already gone */ }

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
}

async function pnlCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;

  const [won, lost, open, redeemed] = await Promise.all([
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'settled',  deleted_at: null } }),
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'lost',     deleted_at: null } }),
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'open',     deleted_at: null } }),
    prismaQuery.hedgePosition.count({ where: { trader_profile_id: profile.id, status: 'redeemed', deleted_at: null } }),
  ]);

  const totalSettled = won + lost;
  const winRate = totalSettled > 0 ? `${Math.round((won / totalSettled) * 100)}%` : '—';
  const streak = won > 0 && lost === 0 ? `🔥 ${won} win streak!` :
                 lost > 0 && won === 0 ? `📉 ${lost} loss streak` :
                 won > lost             ? `📈 Positive run (${won}W / ${lost}L)` :
                 lost > won             ? `📉 Negative run (${won}W / ${lost}L)` : '';

  // Aggregate wagered DUSDC (quantity field, 6 decimals)
  const wageredResult = await prismaQuery.hedgePosition.aggregate({
    where: { trader_profile_id: profile.id, deleted_at: null },
    _sum: { quantity: true },
  });
  const totalWageredRaw = wageredResult._sum.quantity ?? 0n;
  const totalWageredDusdc = (Number(totalWageredRaw) / 1_000_000).toFixed(2);

  await ctx.reply(
    `*Prediction P&L*\n\n` +
    `━━━ *All-time* ━━━\n` +
    `🟢 Active:   ${open}\n` +
    `🏆 Won:      ${won}\n` +
    `❌ Lost:     ${lost}\n` +
    `✅ Claimed:  ${redeemed}\n` +
    `📊 Win rate: ${winRate}\n` +
    (streak ? `\n${streak}\n` : '') +
    `\n━━━ *Volume* ━━━\n` +
    `Total wagered: ${totalWageredDusdc} DUSDC\n\n` +
    `_DeepBook trading P&L is included in the weekly tearsheet._\n` +
    `Use /tearsheet for your public performance URL.`,
    { parse_mode: 'Markdown' },
  );
}

async function tearsheetCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;
  const name = profile.suins_name ?? profile.sui_address;
  const url = `https://lighthouse.wal.app/u/${name}/latest-tearsheet.json`;
  const kb = new InlineKeyboard().url('📄 Open Tearsheet', url);
  await ctx.reply(
    `*Weekly Tearsheet*\n\n` +
    `Your public performance record is anchored to Walrus and verifiable on-chain.\n\n` +
    `\`${url}\``,
    { parse_mode: 'Markdown', reply_markup: kb, link_preview_options: { is_disabled: true } },
  );
}

async function revokeCommand(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text('🛑 Revoke ExecutorAgent', 'revoke:agent')
    .row()
    .text('🔑 Revoke MemWal delegate', 'revoke:memwal')
    .row()
    .text('🚪 Wipe session JWT', 'revoke:session')
    .row()
    .text('Cancel', 'revoke:cancel');
  await ctx.reply(
    '*Revoke* — pick one. Each action is a separate Sui transaction signed in the web app:',
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function revokeAgentCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Opening revoke flow…' });
  const profile = await loadProfile(ctx);
  if (!profile?.executor_agent_id) {
    await ctx.editMessageText('No executor agent to revoke.');
    return;
  }
  await ctx.editMessageText(
    '*Revoke executor agent*\n\n' +
      'Open the web app to confirm and sign the sponsored transaction:\n\n' +
      `https://lighthouse.wal.app/agent/revoke?id=${profile.executor_agent_id}\n\n` +
      '_Under the hood: web app calls POST /agent/revoke → backend builds and ' +
      'sponsors `executor::revoke` PTB → you sign once → on-chain `revoked` flag ' +
      'flips to true and the TradeCap is deregistered from your BalanceManager._',
    { parse_mode: 'Markdown' },
  );
}

async function revokeMemwalCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Opening MemWal revoke flow…' });
  const profile = await loadProfile(ctx);
  if (!profile?.memwal_account_id) {
    await ctx.editMessageText('No MemWal account bound yet.');
    return;
  }
  await ctx.editMessageText(
    'Open the web app to revoke the backend\'s MemWal delegate key:\n\n' +
      `https://lighthouse.wal.app/memwal/revoke?account=${profile.memwal_account_id}\n\n` +
      'Old memories remain readable to whoever holds the original Walrus blobs; new memories will fail until you re-grant.',
  );
}

async function revokeSessionCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Wiping…' });
  // We have no per-bot JWT to wipe (Telegram bot DM is unauthenticated).
  // The web app holds the JWT in localStorage; instruct the user.
  await ctx.editMessageText(
    'To wipe the web-app JWT: clear your browser site data for lighthouse.wal.app, ' +
      'or open the web app menu → Sign out.',
  );
}

async function revokeCancelCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Cancelled' });
  await ctx.editMessageText('Cancelled. Nothing was revoked.');
}

// =============================================================================
// /logout — soft logout: nullify telegram_chat_id, preserve audit trail
// =============================================================================
//
// On-chain assets (BalanceManager, ExecutorAgent, MemWal, positions) are tied
// to `sui_address`, NOT to the Telegram binding. Logout therefore only clears
// `telegram_chat_id` on the TelegramUser row — the row itself + the linked
// TraderProfile + all derived state stay intact. A future /start with the
// same Google account will re-bind the chat id without losing anything.

async function logoutCommand(ctx: Context): Promise<void> {
  if (!ctx.from?.id) return;
  const tgHash = hashTelegramUserId(ctx.from.id);
  const user = await prismaQuery.telegramUser.findUnique({
    where: { telegram_user_id_hash: tgHash },
    select: { id: true },
  });
  if (!user) {
    await ctx.reply("You're not signed in. Use /start to sign in.");
    return;
  }

  const kb = new InlineKeyboard()
    .text('Yes, log me out', 'logout:confirm')
    .text('Cancel', 'logout:cancel');

  await ctx.reply(
    '⚠️ *Disconnect this account?*\n\n' +
      'This unbinds your current Sui address from this Telegram chat. ' +
      'Your on-chain assets (BalanceManager, ExecutorAgent, MemWal, positions) ' +
      'stay yours — only the Telegram binding is cleared.\n\n' +
      "After logout, run /start to sign in with a different Google account (you'll get a fresh Sui address).",
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function logoutCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const action = data.replace(/^logout:/, '');

  if (action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Logout cancelled.');
    } catch (e) {
      console.warn('[bot/logout] edit failed:', (e as Error).message);
    }
    return;
  }

  if (action !== 'confirm') {
    await ctx.answerCallbackQuery();
    return;
  }

  if (!ctx.from?.id) {
    await ctx.answerCallbackQuery({ text: 'Could not identify user.' });
    return;
  }
  const tgHash = hashTelegramUserId(ctx.from.id);

  try {
    // Hard delete the TelegramUser binding row. This is the correct behavior
    // for "I want to bind a different Google account on this Telegram":
    //
    //   - The TraderProfile row (and all on-chain assets — BalanceManager,
    //     ExecutorAgent, MemWal account, positions, tearsheets) is keyed by
    //     `sui_address` and stays intact. The user can always recover access
    //     to those assets by signing in with their ORIGINAL Google account.
    //
    //   - The TelegramUser row exists ONLY as the binding between
    //     telegram_user_id_hash and trader_profile_id. Both fields are
    //     @unique, so soft-deleting it would still trip the unique constraint
    //     when /start tries to re-bind to a different TraderProfile.
    //     Hard delete is the only way to allow a clean re-binding.
    //
    //   - deleteMany is idempotent: 0 rows on retry is fine.
    const res = await prismaQuery.telegramUser.deleteMany({
      where: { telegram_user_id_hash: tgHash },
    });
    console.log(
      `[bot/logout] deleted ${res.count} TelegramUser row(s) for hash ${tgHash.slice(0, 8)}…`,
    );
    await ctx.answerCallbackQuery({ text: 'Logged out' });
    try {
      await ctx.editMessageText(
        '✅ *Logged out.* Run /start to sign in with a different Google account.\n\n' +
          '_Your on-chain assets (BalanceManager, ExecutorAgent, MemWal, positions) ' +
          'are still tied to your original Sui address — sign in with that Google ' +
          'account again to recover them._',
        { parse_mode: 'Markdown' },
      );
    } catch (e) {
      console.warn('[bot/logout] edit on confirm failed:', (e as Error).message);
    }
  } catch (e) {
    console.error('[bot/logout] db delete failed:', (e as Error).message);
    await ctx.answerCallbackQuery({
      text: 'Logout failed — try again or DM the operator.',
      show_alert: true,
    });
  }
}

async function coachForward(ctx: Context): Promise<void> {
  // Intercept setup-flow answers.
  const rawText = ctx.message?.text ?? '';
  if (rawText === '/cancel' || rawText === '/cancel@' + (process.env.TELEGRAM_BOT_USERNAME ?? '')) {
    const cid = ctx.chat?.id;
    if (cid && setupSessions.has(cid)) {
      setupSessions.delete(cid);
      await ctx.reply('Setup cancelled. Run /setup to restart.');
      return;
    }
  }
  if (await handleSetupAnswer(ctx, rawText)) return;

  const text = ctx.message?.text;
  if (!text) return;
  void ctx.replyWithChatAction('typing');

  // Pull the bound profile so we can recall the user's memories. This is the
  // KILLER cross-session-recall demo (UC2): a user who set their risk profile
  // on the web app asks a question in Telegram, and the coach remembers.
  const profile = await loadProfile(ctx);

  let recalledContext = '';
  if (profile?.memwal_account_id && profile?.memwal_delegate_key_encrypted) {
    try {
      const delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
      const recalled = await recallAll(
        { delegateKey, accountId: profile.memwal_account_id },
        text,
        2,
      );
      if (recalled.length > 0) {
        recalledContext =
          '\n\nRecalled from prior sessions (top by similarity):\n' +
          recalled
            .slice(0, 6)
            .map((m, i) => `  [${i}] (dist=${m.distance.toFixed(3)}) ${m.text}`)
            .join('\n');
      }
    } catch (e) {
      console.warn('[telegram] coach recall failed:', (e as Error).message);
    }
  }

  // Inject live trading context: open predict positions + recent DeepBook trades.
  // This lets the coach answer "what did I bet?", "what trades did I place?", etc.
  let tradingContext = '';
  if (profile?.id) {
    try {
      const [openPositions, recentTrades] = await Promise.all([
        prismaQuery.hedgePosition.findMany({
          where: { trader_profile_id: profile.id, status: 'open', deleted_at: null },
          orderBy: { created_at: 'desc' },
          take: 5,
        }),
        prismaQuery.trade.findMany({
          where: { trader_profile_id: profile.id, deleted_at: null },
          orderBy: { created_at: 'desc' },
          take: 5,
        }),
      ]);
      if (openPositions.length > 0) {
        tradingContext +=
          '\n\nUser\'s open DeepBook Predict positions (from this session):\n' +
          openPositions
            .map(
              (p) =>
                `  ${p.is_up ? 'UP' : 'DOWN'} BTC/USD @ strike $${(Number(p.strike) / 1e9).toLocaleString()} — ` +
                `${(Number(p.quantity) / 1_000_000).toFixed(2)} DUSDC — ` +
                `placed ${p.created_at.toISOString().slice(0, 16)} UTC — status: ${p.status}`,
            )
            .join('\n');
      }
      if (recentTrades.length > 0) {
        tradingContext +=
          '\n\nUser\'s recent DeepBook limit orders:\n' +
          recentTrades
            .map(
              (t) =>
                `  ${t.side.toUpperCase()} ${(Number(t.quantity) / 1e9).toFixed(2)} SUI @ ` +
                `${(Number(t.price) / 1e9).toFixed(4)} DBUSDC — status: ${t.status} — ` +
                `${t.created_at.toISOString().slice(0, 16)} UTC`,
            )
            .join('\n');
      }
    } catch (e) {
      console.warn('[telegram] coach trading context failed:', (e as Error).message);
    }
  }

  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are Lighthouse, a verifiable AI trading coach for the Sui ecosystem.\n\n' +
          'FORMATTING RULES (strict):\n' +
          '- Reply in PLAIN TEXT only. No markdown.\n' +
          '- No asterisks for bold (no *text* or **text**).\n' +
          '- No hash headers (no #, ##).\n' +
          '- No code fences (no triple backticks).\n' +
          '- For lists, use simple numbered format: "1. First", "2. Second".\n' +
          '- Use blank lines to separate paragraphs.\n' +
          '- Keep replies under 150 words unless the user asks for depth.\n\n' +
          'CONTENT RULES:\n' +
          '- Be specific about Sui, Walrus, DeepBook, SEAL where relevant.\n' +
          '- If memories from prior sessions are recalled, explicitly reference ' +
          'them by content ("you mentioned earlier that...") to prove ' +
          'cross-session continuity.\n' +
          '- If trading context is provided below, reference it directly when ' +
          'the user asks about their positions or trades.\n' +
          '- Trades go through the on-chain ExecutorAgent budget; the chat ' +
          'discusses strategy, the agent enforces limits.' +
          recalledContext +
          tradingContext,
      },
      { role: 'user', content: text },
    ];
    const res = await chatCreate(messages, {
      model: ATOMA_DEFAULT_MODEL,
      temperature: 0.5,
      maxCompletionTokens: 600,
    });

    // Sanitize any leftover markdown the model might have included despite
    // the plain-text instruction in the system prompt.
    const replyText = stripMarkdown(res.text);

    // Reply with an inline "💾 Save & Anchor" button. When tapped, the
    // backend uploads BOTH the question and this answer to Walrus and emits
    // an on-chain AuditAnchor — proving the exchange happened, immutably,
    // without asking the user to sign anything.
    //
    // Use Telegram's native reply (`reply_parameters`) so the user's
    // original message is attached to the bot's response. This lets the
    // callback handler reconstruct the Q+A from chat history EVEN if the
    // backend's in-memory PENDING_ANCHORS map was wiped by a restart.
    const kb = new InlineKeyboard().text('💾 Save & Anchor', 'coach:anchor');
    const sent = await ctx.reply(replyText, {
      reply_markup: kb,
      reply_parameters: ctx.message?.message_id
        ? { message_id: ctx.message.message_id }
        : undefined,
    });

    // Also remember the Q/A in the in-memory cache (fast path; survives
    // bot replies that aren't reply_parameters-attached).
    if (ctx.chat?.id && sent?.message_id) {
      const payload =
        `Q: ${text}\n\nA: ${replyText}\n\n` +
        `[telegram:${ctx.from?.id ?? 'anon'}@${new Date().toISOString()}]`;
      rememberPendingAnchor(ctx.chat.id, sent.message_id, payload);
    }
  } catch (e) {
    await ctx.reply(`Coach is unavailable: ${(e as Error).message}`);
  }
}

// =============================================================================
// /anchor — explicit standalone anchor of arbitrary text
// =============================================================================
//
// Usage:
//   /anchor Buying SUI at 2.40 was the right call
//
// Uploads the text to Walrus + emits an on-chain AuditAnchor signed by the
// Coach keypair. Returns the tx digest and Walrus blob URL so the user can
// share the receipt.

async function anchorCommand(ctx: Context): Promise<void> {
  const fullText = ctx.message?.text ?? '';
  const note = fullText.replace(/^\/anchor(@\w+)?\s*/i, '').trim();
  if (!note) {
    await ctx.reply(
      'Usage: `/anchor <text>` — uploads to Walrus and emits an on-chain ' +
        'AuditAnchor. Public, immutable, verifiable. Costs nothing for you ' +
        '(Coach pays the gas).',
      { parse_mode: 'Markdown' },
    );
    return;
  }
  if (note.length > 4000) {
    await ctx.reply('Note too long (max 4000 chars). Trim and resend.');
    return;
  }
  void ctx.replyWithChatAction('typing');
  try {
    const r = await anchorText(note);
    await ctx.reply(
      `✅ *Anchored*\n\n` +
        `Tx: \`${r.digest.slice(0, 12)}…\`\n` +
        `Blob: \`${r.blobId.slice(0, 12)}…\`\n\n` +
        `[Explorer](${r.explorerUrl}) · [Walrus](${r.blobUrl})`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  } catch (e) {
    await ctx.reply(`Anchor failed: ${(e as Error).message}`);
  }
}

// =============================================================================
// 💾 Save & Anchor callback (attached to every coach reply)
// =============================================================================

async function coachAnchorCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!chatId || !msgId) {
    await ctx.answerCallbackQuery({ text: 'Missing chat context.' });
    return;
  }

  // Resolve the Q+A payload in this priority order:
  //   1. In-memory PENDING_ANCHORS cache (fast path; populated on reply)
  //   2. Reconstruct from Telegram's reply_to_message (survives restarts)
  //   3. Give up with an honest "expired" message
  let payload = takePendingAnchor(chatId, msgId);
  if (!payload) {
    const msg = ctx.callbackQuery?.message as {
      text?: string;
      reply_to_message?: { text?: string; from?: { id?: number } };
      date?: number;
    } | undefined;
    const coachReply = msg?.text;
    const userQuestion = msg?.reply_to_message?.text;
    if (coachReply && userQuestion) {
      const stamp = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
      payload =
        `Q: ${userQuestion}\n\nA: ${coachReply}\n\n` +
        `[telegram:${ctx.from?.id ?? 'anon'}@${stamp}]`;
    }
  }

  if (!payload) {
    await ctx.answerCallbackQuery({
      text: 'Cannot reconstruct this Q&A (cache empty + no reply context). Send a new question.',
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Anchoring…' });
  try {
    const r = await anchorText(payload);
    // Append the proof line to the original coach reply. The text remains
    // the answer the user got, but now carries on-chain provenance.
    const originalText = ctx.callbackQuery?.message?.text ?? '';
    await ctx.editMessageText(
      `${originalText}\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `✅ *Anchored on Sui*\n` +
        `Tx \`${r.digest.slice(0, 10)}…\` · ` +
        `Blob \`${r.blobId.slice(0, 8)}…\`\n` +
        `[Explorer](${r.explorerUrl}) · [Walrus](${r.blobUrl})`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  } catch (e) {
    await ctx.answerCallbackQuery({
      text: `Anchor failed: ${(e as Error).message}`,
      show_alert: true,
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function loadProfile(ctx: Context) {
  if (!ctx.from?.id) {
    await ctx.reply('Cannot identify Telegram user.');
    return null;
  }
  const tgHash = hashTelegramUserId(ctx.from.id);
  const user = await prismaQuery.telegramUser.findUnique({
    where: { telegram_user_id_hash: tgHash },
    include: { trader_profile: true },
  });
  if (!user) {
    await ctx.reply('No bound Sui address yet. Run /start and complete the web sign-in.');
    return null;
  }
  return user.trader_profile;
}

function makeDisabledStub(): TelegramBotHandle {
  const reject = (): Promise<never> =>
    Promise.reject(new Error('[telegram-bot] disabled: set TELEGRAM_BOT_TOKEN'));
  return {
    enabled: false,
    webhookHandler: () => null,
    sendMessage: reject as TelegramBotHandle['sendMessage'],
    startPolling: reject as TelegramBotHandle['startPolling'],
    stop: () => Promise.resolve(),
  };
}

// =============================================================================
// /trade — DeepBook spot trading via the backend-signed ExecutorAgent
// =============================================================================
//
// Syntax (v1, explicit):
//   /trade buy SUI 0.1 @5.00    (buy 0.1 SUI at $5.00 DBUSDC limit)
//   /trade sell SUI 0.1 @5.00   (sell 0.1 SUI for DBUSDC at $5.00)
//
// Flow:
//   1. Parse the command, validate against agent budget
//   2. Store the parsed trade in PENDING_TRADES under a short id
//   3. Reply with proposal text + inline [✓ Confirm] [✗ Cancel] buttons
//   4. On Confirm: backend builds the place_limit_under_budget PTB with a
//      bundled audit anchor, signs with EXECUTOR_AGENT keypair, executes.
//      Bot edits the message in place with the tx digest + DeepBook order
//      ID + audit anchor info.
//
// IMPORTANT: the ExecutorAgent must have `agent_address = backend executor`
// (set during setup-user-trading-state.ts). If not, the tx aborts with
// ENotAgent and the user sees a clear error.

interface PendingTrade {
  /// TraderProfile.id — needed to persist the Trade row after execution.
  traderProfileId: string;
  /// User's bound Sui address.
  ownerAddress: string;
  /// User's BalanceManager id (shared).
  balanceManagerId: string;
  /// User's ExecutorAgent id (shared).
  executorAgentId: string;
  /// Pool object id.
  poolId: string;
  /// Move type tag for the base coin.
  baseType: string;
  /// Move type tag for the quote coin.
  quoteType: string;
  /// Side: true = bid (buy), false = ask (sell).
  isBid: boolean;
  /// Quantity in BASE raw units (u64).
  quantity: bigint;
  /// Price in DeepBook on-chain format: price_human * quoteScalar (for our
  /// 9/6 decimal SUI/DBUSDC pair).
  price: bigint;
  /// Quote notional = price * quantity / FLOAT_SCALING.
  notional: bigint;
  /// Pretty-printed human values for the proposal text.
  qtyHuman: string;
  priceHuman: string;
  baseSymbol: string;
  quoteSymbol: string;
  /// Telegram message ID the proposal lives on (used by callback to edit).
  chatId: number;
  /// Created time (ms) for TTL eviction.
  createdAtMs: number;
}

const PENDING_TRADES = new Map<string, PendingTrade>();
const MAX_PENDING_TRADES = 200;
const TRADE_TTL_MS = 10 * 60 * 1000; // 10 min

function rememberPendingTrade(id: string, t: PendingTrade): void {
  // Evict expired entries first.
  const now = Date.now();
  for (const [k, v] of PENDING_TRADES.entries()) {
    if (now - v.createdAtMs > TRADE_TTL_MS) PENDING_TRADES.delete(k);
  }
  if (PENDING_TRADES.size >= MAX_PENDING_TRADES) {
    const oldest = PENDING_TRADES.keys().next().value;
    if (oldest) PENDING_TRADES.delete(oldest);
  }
  PENDING_TRADES.set(id, t);
}

function takePendingTrade(id: string): PendingTrade | undefined {
  const v = PENDING_TRADES.get(id);
  if (v) PENDING_TRADES.delete(id);
  return v;
}

/// Coin metadata for /trade parsing. v1 supports SUI base + DBUSDC quote on
/// the canonical SUI/DBUSDC pool. Extend when more pools light up.
///
/// Pool constraints (queried 2026-06-19 from testnet PoolInner dynamic field):
///   SUI/DBUSDC: min_size=1_000_000_000 (1 SUI), lot_size=100_000_000 (0.1 SUI), tick_size=10
const SUPPORTED_PAIRS: Record<
  string,
  {
    poolId: string;
    baseType: string;
    quoteType: string;
    baseScalar: bigint;
    quoteScalar: bigint;
    /// Pool minimum order size in base raw units.
    minSize: bigint;
    /// Pool lot size — quantity must be a multiple of this.
    lotSize: bigint;
    /// Pool tick size — price must be a multiple of this.
    tickSize: bigint;
    baseSymbol: string;
    quoteSymbol: string;
  }
> = {
  SUI: {
    poolId: DEEPBOOK_SUI_DBUSDC_POOL,
    baseType: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    quoteType: DEEPBOOK_DBUSDC_TYPE,
    baseScalar: 1_000_000_000n,
    quoteScalar: 1_000_000n,
    minSize: 1_000_000_000n,   // 1 SUI — pool rejects anything smaller (EOrderBelowMinimumSize)
    lotSize: 100_000_000n,     // 0.1 SUI increments
    tickSize: 10n,             // price must be multiple of 10 raw units
    baseSymbol: 'SUI',
    quoteSymbol: 'DBUSDC',
  },
};

const TRADE_USAGE =
  '*Usage:* `/trade <buy|sell> <coin> <qty> @<price>`\n\n' +
  '*Examples:*\n' +
  '`/trade buy SUI 1 @5.00`\n' +
  '`/trade sell SUI 1 @4.20`\n\n' +
  '_Supported coins: SUI (min 1 SUI, 0.1 SUI increments)._\n\n' +
  'Order is placed by the backend ExecutorAgent within the budget you ' +
  'pre-authorized. No wallet popup. The trade and its rationale anchor in ' +
  'the same atomic on-chain transaction.';

async function tradeCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;
  if (!profile.balance_manager_id || !profile.executor_agent_id) {
    await ctx.reply(
      `Trading isn't set up for your account yet.\n\n` +
        `Run the setup script once:\n` +
        `\`bun run scripts/setup-user-trading-state.ts\`\n\n` +
        `It creates a BalanceManager + ExecutorAgent bound to your address ` +
        `and funds the BM with 0.4 SUI for testing.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const raw = ctx.message?.text ?? '';
  const m = raw.match(/^\/trade(?:@\w+)?\s+(buy|sell)\s+([A-Z]+)\s+([\d.]+)\s+@\s*([\d.]+)\s*$/i);
  if (!m) {
    await ctx.reply(TRADE_USAGE, { parse_mode: 'Markdown' });
    return;
  }

  const side = m[1].toLowerCase() as 'buy' | 'sell';
  const symbol = m[2].toUpperCase();
  const qtyHuman = m[3];
  const priceHuman = m[4];
  const pair = SUPPORTED_PAIRS[symbol];
  if (!pair) {
    await ctx.reply(`Unsupported coin: ${symbol}. Try SUI.`);
    return;
  }

  const qtyNum = Number(qtyHuman);
  const priceNum = Number(priceHuman);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0 || !Number.isFinite(priceNum) || priceNum <= 0) {
    await ctx.reply(`Bad numbers. Quantity and price must be positive.`);
    return;
  }
  if (qtyNum > 10) {
    await ctx.reply(`For demo safety, max quantity is 10 ${symbol} per order.`);
    return;
  }

  // Floor to raw units then snap DOWN to nearest lot_size.
  // Pool requires: quantity >= minSize AND quantity % lotSize == 0.
  let quantity = BigInt(Math.floor(qtyNum * Number(pair.baseScalar)));
  quantity = quantity - (quantity % pair.lotSize);
  if (quantity < pair.minSize) {
    const minHuman = Number(pair.minSize) / Number(pair.baseScalar);
    const lotHuman = Number(pair.lotSize) / Number(pair.baseScalar);
    await ctx.reply(
      `Minimum order is ${minHuman} ${symbol} (lot size: ${lotHuman} ${symbol}). ` +
        `Try \`/trade ${side} ${symbol} ${minHuman} @${priceHuman}\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // DeepBook SDK convertPrice formula: price * FLOAT_SCALAR * quoteScalar / baseScalar
  // Snap DOWN to nearest tick_size — pool requires price % tickSize == 0.
  let price = BigInt(
    Math.floor((priceNum * 1e9 * Number(pair.quoteScalar)) / Number(pair.baseScalar)),
  );
  price = price - (price % pair.tickSize);
  if (price === 0n) {
    await ctx.reply(`Price too small — rounds to zero after tick alignment.`);
    return;
  }
  const notional = (price * quantity) / 1_000_000_000n;

  // Pre-flight: check budget via cached agent snapshot.
  let agent;
  try {
    agent = await getCachedExecutorAgent(profile.id, profile.executor_agent_id);
  } catch (e) {
    await ctx.reply(`Could not read ExecutorAgent: ${(e as Error).message}`);
    return;
  }
  if (agent.revoked) {
    await ctx.reply(`Your ExecutorAgent has been revoked. Trading is disabled.`);
    return;
  }
  if (notional > agent.max_notional_per_trade) {
    await ctx.reply(
      `Trade size (${notional.toString()} ${pair.quoteSymbol} raw) exceeds your ` +
        `per-trade cap (${agent.max_notional_per_trade.toString()} raw).`,
    );
    return;
  }
  const remainingToday = agent.max_notional_per_day - agent.spent_today;
  if (notional > remainingToday) {
    await ctx.reply(
      `Trade size (${notional.toString()} raw) exceeds your remaining daily ` +
        `budget (${remainingToday.toString()} raw).`,
    );
    return;
  }

  const tradeId = nanoid(10);
  if (!ctx.chat?.id) return;
  rememberPendingTrade(tradeId, {
    traderProfileId: profile.id,
    ownerAddress: profile.sui_address,
    balanceManagerId: profile.balance_manager_id,
    executorAgentId: profile.executor_agent_id,
    poolId: pair.poolId,
    baseType: pair.baseType,
    quoteType: pair.quoteType,
    isBid: side === 'buy',
    quantity,
    price,
    notional,
    qtyHuman,
    priceHuman,
    baseSymbol: pair.baseSymbol,
    quoteSymbol: pair.quoteSymbol,
    chatId: ctx.chat.id,
    createdAtMs: Date.now(),
  });

  const kb = new InlineKeyboard()
    .text('✓ Confirm', `trade:confirm:${tradeId}`)
    .text('✗ Cancel', `trade:cancel:${tradeId}`);

  const sideUpper = side === 'buy' ? 'BUY' : 'SELL';
  const notionalHuman = (Number(notional) / Number(pair.quoteScalar)).toFixed(4);
  await ctx.reply(
    `*Coach proposes:*\n\n` +
      `${sideUpper} ${qtyHuman} ${pair.baseSymbol} @ ${priceHuman} ${pair.quoteSymbol}\n` +
      `Notional: ~${notionalHuman} ${pair.quoteSymbol}\n\n` +
      `Per-trade cap: ${agent.max_notional_per_trade.toString()} raw\n` +
      `Today remaining: ${remainingToday.toString()} raw\n\n` +
      `_Backend signs via ExecutorAgent. No wallet popup. ` +
      `The order and its on-chain audit anchor land in one atomic tx._`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function tradeConfirmCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const tradeId = data.replace(/^trade:confirm:/, '');
  const trade = takePendingTrade(tradeId);
  if (!trade) {
    await ctx.answerCallbackQuery({
      text: 'This trade proposal expired. Send /trade again.',
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Submitting…' });
  try {
    // Build the trade-with-audit-anchor PTB. Walrus blob bytes are a
    // placeholder rationale tag — production wires the actual coach
    // rationale uploaded via lib/walrus.ts. For demo we use a tagged hash.
    const rationale = new TextEncoder().encode(
      `trade:${trade.baseSymbol}/${trade.quoteSymbol}:` +
        `${trade.isBid ? 'BUY' : 'SELL'}:${trade.qtyHuman}@${trade.priceHuman}:` +
        `${trade.ownerAddress.slice(0, 10)}@${Date.now()}`,
    );
    const tx = buildPlaceLimitTx({
      executorAgentId: trade.executorAgentId,
      balanceManagerId: trade.balanceManagerId,
      poolId: trade.poolId,
      baseType: trade.baseType,
      quoteType: trade.quoteType,
      clientOrderId: BigInt(Date.now()),
      orderType: 0,
      selfMatching: 0,
      price: trade.price,
      quantity: trade.quantity,
      isBid: trade.isBid,
      payWithDeep: false,
      // DeepBook MAX_TIMESTAMP = no expiry sentinel (from @mysten/deepbook-v3 config.mjs).
      // Passing 0 causes EInvalidExpireTimestamp (abort code 3) because the pool checks
      // that current_clock_ms <= expire_timestamp.
      expireTimestamp: 1844674407370955161n,
      auditWalrusBlobIdBytes: rationale,
    });

    const executor = getExecutorKeypair();
    tx.setSender(executor.toSuiAddress());
    tx.setGasBudget(200_000_000);

    const built = await tx.build({ client: suiGrpc as never });
    const sig = await executor.signTransaction(built);
    const result = (await suiGrpc.executeTransaction({
      transaction: built,
      signatures: [sig.signature],
    })) as { Transaction?: { digest?: string; status?: { success?: boolean; error?: string | null } }; digest?: string };
    const inner = result.Transaction ?? {};
    const digest = inner.digest ?? result.digest;
    const succeeded = inner.status?.success !== false;

    if (!digest || !succeeded) {
      const err = inner.status?.error ?? 'unknown';
      // Classify the abort for a human-readable hint.
      let hint: string;
      // DeepBook order_info abort codes (module = order_info::validate_inputs):
      //   0 = EOrderInvalidPrice, 1 = EOrderBelowMinimumSize, 2 = EOrderInvalidLotSize,
      //   3 = EInvalidExpireTimestamp, 4 = EInvalidOrderType
      // Lighthouse executor abort codes (module = executor::place_limit_under_budget):
      //   0 = EBudgetExceeded, 3 = ENotAgent, 5 = ERevoked, 2 = EExpired
      if (err.includes('order_info') && err.includes('abort_code: 1')) {
        hint = '_Order below pool minimum size (1 SUI). Use at least 1 SUI._';
      } else if (err.includes('order_info') && err.includes('abort_code: 2')) {
        hint = '_Order quantity is not a valid lot-size multiple (0.1 SUI increments)._';
      } else if (err.includes('order_info') && err.includes('abort_code: 3')) {
        hint = '_Order expiry timestamp is in the past. This is a backend bug._';
      } else if (err.includes('order_info') && err.includes('abort_code: 0')) {
        hint = '_Order price is invalid or not aligned to tick size._';
      } else if (err.includes('ENotAgent') || (err.includes('executor') && err.includes('abort_code: 3'))) {
        hint =
          '_ExecutorAgent agent_address mismatch. Re-run setup-user-trading-state.ts._';
      } else if (err.includes('EBudgetExceeded') || (err.includes('executor') && err.includes('abort_code: 0'))) {
        hint = '_Budget exceeded on-chain — try a smaller size._';
      } else if (err.includes('EPackageVersionDisabled') || err.includes('abort_code: 11')) {
        // Abort code 11 = EPackageVersionDisabled in deepbook::pool.
        // Root cause: Lighthouse was linked against DeepBook testnet-v19
        // (CURRENT_VERSION=8) but the testnet pool only allows versions {1..5}.
        // Fix: upgrade Lighthouse against DeepBook testnet-v17 (CURRENT_VERSION=5).
        hint =
          '_DeepBook version mismatch (code 11). The Lighthouse package needs ' +
          'to be upgraded against DeepBook testnet-v17. Contact the operator._';
      } else if (err.includes('ERevoked') || err.includes('abort_code: 5')) {
        hint = '_ExecutorAgent has been revoked. Use /revoke to set up a new one._';
      } else if (err.includes('EExpired') || err.includes('abort_code: 2')) {
        hint = '_ExecutorAgent has expired. Re-run the setup script._';
      } else {
        hint = '_See suiscan.xyz/testnet for the full on-chain abort trace._';
      }
      await ctx.editMessageText(
        `❌ Trade failed: ${err}\n\n${hint}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // Persist to DB so the coach can reference it in future context.
    try {
      await prismaQuery.trade.create({
        data: {
          trader_profile_id: trade.traderProfileId,
          pool_id: trade.poolId,
          client_order_id: BigInt(Date.now()),
          side: trade.isBid ? 'bid' : 'ask',
          price: trade.price,
          quantity: trade.quantity,
          notional: trade.notional,
          status: 'placed',
          tx_digest: digest,
        },
      });
    } catch (dbErr) {
      console.warn('[trade] DB persist failed (non-fatal):', (dbErr as Error).message);
    }

    // ─── MemWal write-back (non-fatal) ──────────────────────────────────────
    try {
      const memProfile = await prismaQuery.traderProfile.findUnique({
        where: { id: trade.traderProfileId },
        select: { id: true, memwal_account_id: true, memwal_delegate_key_encrypted: true },
      });
      if (memProfile?.memwal_account_id && memProfile?.memwal_delegate_key_encrypted) {
        const delegateKey = envelopeDecrypt(memProfile.id, memProfile.memwal_delegate_key_encrypted);
        const account = { delegateKey, accountId: memProfile.memwal_account_id };
        const narrative =
          `Placed ${trade.isBid ? 'BUY' : 'SELL'} order on ${trade.baseSymbol}/${trade.quoteSymbol}: ` +
          `${trade.qtyHuman} ${trade.baseSymbol} at ${trade.priceHuman} ${trade.quoteSymbol}. ` +
          `Status: placed. TX: ${digest}. Date: ${new Date().toISOString()}.`;
        analyzeAndRemember(account, narrative, NAMESPACES.trades, new Date()).catch((e: unknown) => {
          console.warn('[trade] memwal async write failed:', (e as Error).message);
        });
      }
    } catch (memErr) {
      console.warn('[trade] memwal write-back failed (non-fatal):', (memErr as Error).message);
    }

    const explorer = `https://suiscan.xyz/testnet/tx/${digest}`;
    await ctx.editMessageText(
      `✅ *Order placed*\n\n` +
        `${trade.isBid ? 'BUY' : 'SELL'} ${trade.qtyHuman} ${trade.baseSymbol} @ ` +
        `${trade.priceHuman} ${trade.quoteSymbol}\n\n` +
        `Tx: \`${digest.slice(0, 14)}…\`\n` +
        `[View on explorer](${explorer})\n\n` +
        `_One PTB: executor::place_limit_under_budget + ` +
        `pool::place_limit_order + audit_anchor::record_\n` +
        `_Signed by backend ExecutorAgent — zero user signatures._`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  } catch (e) {
    await ctx.editMessageText(
      `❌ Trade build/submit failed: ${(e as Error).message}`,
    );
  }
}

async function tradeCancelCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const tradeId = data.replace(/^trade:cancel:/, '');
  takePendingTrade(tradeId);
  await ctx.answerCallbackQuery({ text: 'Cancelled' });
  await ctx.editMessageText('✗ Trade cancelled. Nothing was placed.');
}

// =============================================================================
// /predict — DeepBook Predict binary positions (scaffolded; awaits DUSDC)
// =============================================================================
//
// Predict flow needs:
//   - User's PredictManager (created via /predict/onboard or auto on first use)
//   - Testnet DUSDC in the PredictManager (separate faucet)
//   - An active oracle market for the underlying
//
// =============================================================================
// /deposit — two-phase flow depending on whether a DepositCap is set up
// =============================================================================
//
// Phase 1 (no DepositCap yet — first-time setup):
//   - Show user's zkLogin bound address to send SUI to
//   - Callback button "I've sent SUI" checks balance first, THEN surfaces OAuth URL
//   - After OAuth the deposit PTB also mints a DepositCap for the executor
//
// Phase 2 (DepositCap exists — all subsequent deposits):
//   - Show executor address to send SUI to
//   - Callback button "Confirm X SUI deposit" → executor calls deposit_with_cap
//   - NO Google OAuth required
//
// =============================================================================

/** Shared helper: resolve profile from tgUserId. Returns null and replies on error. */
async function resolveDepositProfile(ctx: Context): Promise<{
  tgHash: string;
  profile: {
    id: string;
    sui_address: string;
    balance_manager_id: string | null;
    deposit_cap_id: string | null;
    predict_manager_id: string | null;
  };
} | null> {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) { await ctx.reply('Could not identify user.'); return null; }
  const tgHash = hashTelegramUserId(tgUserId);
  const tgUser = await prismaQuery.telegramUser.findUnique({
    where: { telegram_user_id_hash: tgHash },
    include: {
      trader_profile: {
        select: {
          id: true,
          sui_address: true,
          balance_manager_id: true,
          deposit_cap_id: true,
          predict_manager_id: true,
        },
      },
    },
  });
  if (!tgUser?.trader_profile) {
    await ctx.reply('Please complete /start first to set up your account.');
    return null;
  }
  if (!tgUser.trader_profile.balance_manager_id) {
    await ctx.reply('Your trading account is still being set up. Try again in a moment.');
    return null;
  }
  return { tgHash, profile: tgUser.trader_profile };
}

/** Parse and validate a SUI amount string → MIST bigint. */
function parseDepositAmount(amountStr: string): { mist: bigint; display: string } | null {
  const parsed = parseFloat(amountStr);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed < 0.1) return null;
  return { mist: BigInt(Math.floor(parsed * 1e9)), display: `${parsed} SUI` };
}

async function depositCommand(ctx: Context): Promise<void> {
  const resolved = await resolveDepositProfile(ctx);
  if (!resolved) return;
  const { profile } = resolved;

  const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
  const amountStr = args[0];
  if (!amountStr) {
    // Probe wallet balance so we can surface the sweep path when SUI is
    // already sitting in the user's bound address (a common mistake).
    let walletSuiHint = '';
    try {
      const rpc = suiRpc as unknown as {
        getBalance: (a: { owner: string; coinType?: string }) => Promise<{ totalBalance: string }>;
      };
      const bal = await rpc.getBalance({ owner: profile.sui_address });
      const totalMist = BigInt(bal.totalBalance);
      if (totalMist > 50_000_000n) {
        const suiDisplay = (Number(totalMist) / 1e9).toFixed(4);
        const executorAddr = getExecutorKeypair().toSuiAddress();
        walletSuiHint =
          `\n\nℹ️ Your wallet already holds ${suiDisplay} SUI. ` +
          `Use /sweep to move it to your BalanceManager in one tap, ` +
          `or send fresh SUI to the executor:\n\`${executorAddr}\``;
      }
    } catch {
      // Best-effort hint — never block the command on RPC issues.
    }
    await ctx.reply(
      `Usage: /deposit <amount>\nExample: /deposit 2.5\n\nMinimum: 0.1 SUI${walletSuiHint}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const parsed = parseDepositAmount(amountStr);
  if (!parsed) {
    await ctx.reply('Invalid amount. Minimum is 0.1 SUI.\nExample: /deposit 2.5');
    return;
  }
  const { mist: amountMist, display: amountDisplay } = parsed;

  // ── Phase 2: DepositCap exists → send SUI to executor, one-tap confirm ──
  if (profile.deposit_cap_id) {
    const executorAddr = getExecutorKeypair().toSuiAddress();
    const cbData = `dep:confirm:${amountMist}:${profile.id}`;
    const kb = new InlineKeyboard().text(`✅ Confirm ${amountDisplay} Deposit`, cbData);
    await ctx.reply(
      `💰 Deposit to Trading Account\n\n` +
        `Send ${amountDisplay} from your Slush wallet to:\n\n` +
        `\`${executorAddr}\`\n\n` +
        `After sending, tap the button below to complete:`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  // ── Phase 1: No DepositCap → show bound address, check balance before OAuth ─
  // Callback data must stay under Telegram's 64-byte limit.
  // tgHash is NOT included — depositCheckCallback looks it up via profileId.
  const boundAddr = profile.sui_address;
  const cbData = `dep:check:${amountMist}:${profile.id}`;
  const kb = new InlineKeyboard().text(`✅ I've Sent ${amountDisplay} — Continue`, cbData);
  await ctx.reply(
    `💰 Deposit to Trading Account (one-time setup)\n\n` +
      `Step 1 — Send ${amountDisplay} from your Slush wallet to your Lighthouse address:\n\n` +
      `\`${boundAddr}\`\n\n` +
      `Step 2 — After sending, tap the button below.\n` +
      `_(After this, future deposits won't need Google sign-in.)_`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

// =============================================================================
// /sweep — move SUI sitting in the user's bound wallet to their BalanceManager.
// =============================================================================
//
// Use case: user accidentally sent SUI to their own zkLogin-bound address
// (instead of the executor). The auto-sweep worker can't move it because the
// coin is owned by the user, not the executor. This command builds an OAuth
// flow that calls DepositService.depositViaZkLogin server-side: the user
// signs as themselves via zkLogin, the SUI lands in the BM.
//
// We reserve 0.05 SUI in the wallet so the address keeps a non-zero balance
// for any future unsponsored ops it might need.
async function sweepCommand(ctx: Context): Promise<void> {
  const resolved = await resolveDepositProfile(ctx);
  if (!resolved) return;
  const { tgHash, profile } = resolved;

  const RESERVE_MIST = 50_000_000n; // 0.05 SUI

  let totalMist: bigint;
  try {
    const rpc = suiRpc as unknown as {
      getBalance: (a: { owner: string; coinType?: string }) => Promise<{ totalBalance: string }>;
    };
    const bal = await rpc.getBalance({ owner: profile.sui_address });
    totalMist = BigInt(bal.totalBalance);
  } catch (e) {
    console.error('[bot/sweep] getBalance failed:', e);
    await ctx.reply(
      'Could not reach the Sui RPC to check your wallet balance. Please try again in a moment.',
    );
    return;
  }

  if (totalMist <= RESERVE_MIST) {
    const executorAddr = getExecutorKeypair().toSuiAddress();
    const have = (Number(totalMist) / 1e9).toFixed(4);
    await ctx.reply(
      `Your wallet currently holds ${have} SUI — below the 0.05 SUI sweep ` +
        `minimum.\n\nIf you want to add funds, send SUI from your Slush ` +
        `wallet directly to the executor (auto-credited within ~30s):\n\n` +
        `\`${executorAddr}\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const sweepMist = totalMist - RESERVE_MIST;
  const sweepDisplay = (Number(sweepMist) / 1e9).toFixed(4);

  let oauthUrl: string;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash, {
      action: 'sweep_to_bm',
      action_meta: { traderProfileId: profile.id },
      ttlMs: 10 * 60 * 1000,
    });
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    console.error('[bot/sweep] OAuth build failed:', e);
    await ctx.reply('Could not generate sign-in link. Please try again or contact support.');
    return;
  }

  const kb = new InlineKeyboard().url('🔐 Sign in with Google', oauthUrl);
  await ctx.reply(
    `💸 Move *${sweepDisplay} SUI* from your wallet → BalanceManager.\n\n` +
      `Tap to sign in with Google (one-shot, ~10s). We'll leave 0.05 SUI ` +
      `in your wallet as a reserve.`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

// ── /topup — move DUSDC from the user's bound zkLogin wallet into their ──────
// PredictManager via an OAuth roundtrip. Mirrors /sweep exactly but operates
// on DUSDC → PredictManager instead of SUI → BalanceManager.
//
// Prerequisite: profile.predict_manager_id must already exist (the user must
// have completed Phase 1 of /predict at least once). This command is purely
// for *additional* funding — Phase 1 setup remains in /predict.
//
// Defaults: 50 DUSDC. Minimum: 1 DUSDC. Reject larger-than-wallet up-front.
async function topupCommand(ctx: Context): Promise<void> {
  const profile = await loadProfile(ctx);
  if (!profile) return;
  if (!profile.predict_manager_id) {
    await ctx.reply(
      "Your PredictManager isn't set up yet — run /predict first to create " +
        'and fund it with your initial DUSDC deposit.',
    );
    return;
  }

  // tgHash needed for buildTelegramOAuthFlow — derive from the message sender.
  if (!ctx.from?.id) {
    await ctx.reply('Could not identify user.');
    return;
  }
  const tgHash = hashTelegramUserId(ctx.from.id);

  // ── Parse the amount argument (defaults to 50 DUSDC). ──────────────────────
  const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
  const amountStr = args[0];
  const humanAmount = amountStr ? parseFloat(amountStr) : 50;
  if (!Number.isFinite(humanAmount) || humanAmount < 1) {
    await ctx.reply('Invalid amount. Minimum is 1 DUSDC.\nExample: /topup 25');
    return;
  }
  // DUSDC has 6 decimals on testnet.
  const amountRaw = BigInt(Math.floor(humanAmount * 1_000_000));
  if (amountRaw <= 0n) {
    await ctx.reply('Invalid amount. Minimum is 1 DUSDC.');
    return;
  }
  const amountDisplay = humanAmount.toLocaleString(undefined, { maximumFractionDigits: 6 });

  // ── Verify the bound wallet holds enough DUSDC up-front. ───────────────────
  // Without this check the OAuth flow would still trigger and only fail inside
  // depositDusdcIntoExistingManager when no coin >= amountRaw is found — that
  // wastes a Google round-trip and shows a generic error page.
  let walletRawDusdc: bigint;
  try {
    const rpc = suiRpc as unknown as {
      getBalance: (a: { owner: string; coinType?: string }) => Promise<{ totalBalance: string }>;
    };
    const bal = await rpc.getBalance({ owner: profile.sui_address, coinType: DUSDC_TYPE_TAG });
    walletRawDusdc = BigInt(bal.totalBalance);
  } catch (e) {
    console.error('[bot/topup] getBalance failed:', e);
    await ctx.reply(
      'Could not reach the Sui RPC to check your wallet DUSDC balance. Please try again in a moment.',
    );
    return;
  }

  if (walletRawDusdc < amountRaw) {
    const haveHuman = (Number(walletRawDusdc) / 1e6).toFixed(2);
    await ctx.reply(
      `⚠️ You have *${haveHuman} DUSDC* in your wallet but tried to top up ` +
        `*${amountDisplay} DUSDC*.\n\n` +
        `Send more DUSDC to your bound address:\n\n` +
        `\`${profile.sui_address}\`\n\n` +
        `Then run /topup ${amountDisplay} again.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // ── Build the OAuth flow. action=predict_setup, amountRaw routed via meta ──
  // The OAuth callback's predict_setup branch calls setupPredictViaZkLogin,
  // which sees the existing predict_manager_id and routes through the
  // top-up branch (skips create_manager, runs only the deposit PTB).
  let oauthUrl: string;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash, {
      action: 'predict_setup',
      action_meta: {
        traderProfileId: profile.id,
        amountRaw: amountRaw.toString(),
      },
      ttlMs: 10 * 60 * 1000,
    });
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    console.error('[bot/topup] OAuth build failed:', e);
    await ctx.reply('Could not generate sign-in link. Please try again or contact support.');
    return;
  }

  const kb = new InlineKeyboard().url('🔐 Sign in with Google', oauthUrl);
  await ctx.reply(
    `💰 Top up *${amountDisplay} DUSDC* → PredictManager\n\n` +
      `Tap to sign in with Google (one-shot, ~5s):\n\n` +
      `_DUSDC moves from your wallet → PredictManager. Sponsored, no gas._`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

// ── Deposit callback: check balance, then show OAuth URL ──────────────────────
// Callback data format: dep:check:MIST:PROFILE_ID  (≤ 64 bytes)
async function depositCheckCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  // parts: ['dep', 'check', MIST, PROFILE_ID]
  if (parts.length < 4) { await ctx.reply('Invalid callback data.'); return; }

  let amountMist: bigint;
  try {
    amountMist = BigInt(parts[2]);
  } catch {
    await ctx.reply('Invalid deposit amount in callback. Please run /deposit again.');
    return;
  }
  const profileId = parts[3];

  let tgHash: string;
  let profile: { id: string; sui_address: string; balance_manager_id: string | null; deposit_cap_id: string | null } | null;
  try {
    // Look up tgHash via the TelegramUser linked to this profile.
    const tgUser = await prismaQuery.telegramUser.findFirst({
      where: { trader_profile_id: profileId },
      select: { telegram_user_id_hash: true },
    });
    tgHash = tgUser?.telegram_user_id_hash ?? '';
    if (!tgHash) {
      await ctx.reply('Could not find your Telegram account. Please /start again.');
      return;
    }

    // Reload profile from DB to get bound address.
    profile = await prismaQuery.traderProfile.findUnique({
      where: { id: profileId },
      select: { id: true, sui_address: true, balance_manager_id: true, deposit_cap_id: true },
    });
    if (!profile?.balance_manager_id) {
      await ctx.reply('Profile not found. Please /start again.');
      return;
    }
  } catch (e) {
    console.error('[bot/deposit-check] DB lookup failed:', e);
    await ctx.reply('Database error while looking up your profile. Please try again.');
    return;
  }

  // If DepositCap was set between command and callback, skip OAuth.
  if (profile.deposit_cap_id) {
    const executorAddr = getExecutorKeypair().toSuiAddress();
    const cbData = `dep:confirm:${amountMist}:${profileId}`;
    const kb = new InlineKeyboard().text(`✅ Confirm ${Number(amountMist) / 1e9} SUI Deposit`, cbData);
    await ctx.reply(
      `✅ Setup complete! For future deposits just send SUI to:\n\n` +
        `\`${executorAddr}\`\n\nThen tap confirm.`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  // Check if the bound address has a SUI coin >= amountMist.
  // Use suiRpc.getCoins() — a typed, first-class SDK method.
  let hasSui = false;
  let rpcError: string | null = null;
  try {
    const coinsResp = await suiRpc.getCoins({
      owner: profile.sui_address,
      coinType: '0x2::sui::SUI',
    });
    hasSui = (coinsResp.data ?? []).some((c) => BigInt(c.balance) >= amountMist);
  } catch (e) {
    rpcError = (e as Error).message ?? String(e);
    console.error('[bot/deposit-check] coin query failed:', e);
  }

  if (rpcError !== null) {
    const amountDisplay = `${Number(amountMist) / 1e9} SUI`;
    const cbData = `dep:check:${amountMist}:${profileId}`;
    const kb = new InlineKeyboard().text('🔄 Check Again', cbData);
    await ctx.reply(
      `⚠️ Could not reach the Sui RPC to verify your balance. This is a temporary issue.\n\n` +
        `If you have already sent ${amountDisplay} to:\n\`${profile.sui_address}\`\n\n` +
        `Tap Check Again in a moment.`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  if (!hasSui) {
    const amountDisplay = `${Number(amountMist) / 1e9} SUI`;
    const cbData = `dep:check:${amountMist}:${profileId}`;
    const kb = new InlineKeyboard().text('🔄 Check Again', cbData);
    await ctx.reply(
      `⏳ ${amountDisplay} not detected yet at your Lighthouse address.\n\n` +
        `Make sure you sent to:\n\`${profile.sui_address}\`\n\n` +
        `Wait a few seconds for the transaction to confirm, then tap Check Again.`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  // SUI confirmed — now show the OAuth URL.
  const amountDisplay = `${Number(amountMist) / 1e9} SUI`;
  let oauthUrl: string;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash, {
      action: 'deposit',
      action_meta: { amountMist: amountMist.toString(), traderProfileId: profileId },
    });
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    console.error('[bot/deposit-check] OAuth build failed:', e);
    await ctx.reply('Could not generate sign-in link. Please try again or contact support.');
    return;
  }

  const kb = new InlineKeyboard().url(`🔐 Sign & Complete Deposit`, oauthUrl);
  await ctx.reply(
    `✅ ${amountDisplay} detected at your address!\n\n` +
      `Tap the button below to authorise the deposit (opens your browser):\n` +
      `_You'll sign in with Google once. After this, deposits are instant._`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

// ── Deposit callback: executor calls deposit_with_cap (no OAuth) ──────────────
// Callback data format: dep:confirm:MIST:PROFILE_ID
async function depositConfirmCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery('Processing deposit…');
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  if (parts.length < 4) return;
  const amountMist = BigInt(parts[2]);
  const profileId = parts[3];

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: { balance_manager_id: true, deposit_cap_id: true },
  });
  if (!profile?.balance_manager_id || !profile.deposit_cap_id) {
    await ctx.reply('Deposit setup not complete. Please run /deposit again.');
    return;
  }

  const amountDisplay = `${Number(amountMist) / 1e9} SUI`;
  try {
    const executor = getExecutorKeypair();
    const tx = buildDepositTx(
      profile.balance_manager_id,
      profile.deposit_cap_id,
      amountMist,
      SUI_TYPE_TAG_DEP,
    );
    tx.setSender(executor.toSuiAddress());
    tx.setGasBudget(30_000_000);

    const result = (await suiGrpc.signAndExecuteTransaction({
      signer: executor,
      transaction: tx,
    })) as { Transaction?: { digest?: string; status?: { success?: boolean; error?: string | null } } };

    const inner = result.Transaction ?? {};
    if (inner.status?.success === false) {
      throw new Error(inner.status.error ?? 'tx failed');
    }

    const digest = inner.digest ?? '(no digest)';
    await ctx.reply(
      `✅ ${amountDisplay} deposited to your trading account!\n\n` +
        `Tx: [${digest.slice(0, 12)}…](https://suiscan.xyz/testnet/tx/${digest})`,
      { parse_mode: 'Markdown' },
    );
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error('[bot/deposit-confirm] deposit_with_cap failed:', msg);
    await ctx.reply(
      `❌ Deposit failed: ${msg.slice(0, 200)}\n\n` +
        `Make sure you sent SUI to the executor address first, then try again.`,
    );
  }
}

// =============================================================================
// /predict — DeepBook Predict binary options (executor-signed)
// =============================================================================
//
// Two-step flow (no user gas, no wallet popup):
//   1. /predict — bot pulls active BTC markets from the predict server,
//      shows up to 3 with UP/DOWN buttons.
//   2. User taps UP or DOWN — backend builds a single PTB that:
//        a. splits 10 DUSDC off the executor's DUSDC coin
//        b. deposits into the shared PredictManager
//        c. constructs MarketKey
//        d. mints the binary position
//      …signs with the EXECUTOR_AGENT keypair, executes, and records the
//      position in HedgePosition (best-effort, non-fatal on DB error).

/// 10 DUSDC per prediction (DUSDC has 6 decimals on testnet → 10_000_000 raw).
const PREDICT_QUANTITY_RAW = 10_000_000n;

/// Default DUSDC deposit at /predict setup time: 50 DUSDC = 50_000_000 raw.
const PREDICT_DEFAULT_DEPOSIT_RAW = 50_000_000n;

/**
 * MarkdownV2 escape per Telegram bot API spec. Inside normal text the special
 * chars are `_*[]()~`>#+-=|{}.!` and they MUST be escaped with backslash.
 * We use MarkdownV2 because vanilla Markdown is being deprecated.
 */
function escMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

/**
 * /predict — two-phase per-user DeepBook Predict.
 *
 *   Phase 1 (profile.predict_manager_id missing): show the user their bound
 *     address + ask them to send DUSDC, then surface a "I've Sent DUSDC" button
 *     that runs the OAuth + create_manager + deposit flow.
 *   Phase 2 (profile.predict_manager_id present): list active BTC markets with
 *     UP/DOWN buttons. Tapping a button kicks off an OAuth flow that signs
 *     predict::mint as the user (debits the manager's internal DUSDC balance).
 *
 * Both phases use sponsored zkLogin transactions — zero gas, no wallet popup.
 */
async function predictCommand(ctx: Context): Promise<void> {
  const resolved = await resolveDepositProfile(ctx);
  if (!resolved) return;
  const { profile } = resolved;

  // ── Banner: unclaimed wins ─────────────────────────────────────────────────
  // Remind the user of any settled-but-not-redeemed positions before showing
  // the market list so they don't miss a payout.
  try {
    const unclaimedCount = await prismaQuery.hedgePosition.count({
      where: { trader_profile_id: profile.id, status: 'settled', deleted_at: null },
    });
    if (unclaimedCount > 0) {
      await ctx.reply(
        `🎉 You have *${unclaimedCount}* unclaimed win${unclaimedCount > 1 ? 's' : ''}! ` +
          `Use /positions to see your positions and claim your DUSDC payout.`,
        { parse_mode: 'Markdown' },
      );
    }
  } catch {
    // Non-fatal — don't block market display.
  }

  // ── Phase 1: no PredictManager yet → setup prompt ─────────────────────────
  if (!profile.predict_manager_id) {
    const dusdcAmountHuman = (Number(PREDICT_DEFAULT_DEPOSIT_RAW) / 1e6).toFixed(0);
    const cbData = `prd:setup:${profile.id}`;
    const kb = new InlineKeyboard().text(
      `✅ I've Sent DUSDC — Set Up Predict`,
      cbData,
    );
    await ctx.reply(
      `🎯 *DeepBook Predict — Setup Required*\n\n` +
        `Your Predict account needs to be set up first.\n\n` +
        `*Step 1:* Send *${dusdcAmountHuman} DUSDC* (testnet) from your Slush wallet to your Lighthouse address:\n\n` +
        `\`${profile.sui_address}\`\n\n` +
        `*Step 2:* After sending, tap the button below. We will:\n` +
        `  1. Verify the DUSDC arrived at your address\n` +
        `  2. Create your PredictManager on-chain\n` +
        `  3. Deposit the DUSDC into the manager\n\n` +
        `_All sponsored — zero gas from you._`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  // ── Phase 2: PredictManager exists → show active markets ──────────────────
  if (!PREDICT_OBJECT_ID) {
    await ctx.reply(
      '⚙️ Predict not configured yet. PREDICT_OBJECT_ID missing from env.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  await ctx.reply('⏳ Fetching active markets...');

  try {
    const markets = await getActiveMarkets(PREDICT_SERVER_URL, SUI_RPC_URL);

    if (markets.length === 0) {
      await ctx.reply(
        '📊 *No active BTC markets right now*\n\nMysten creates new prediction markets every \\~15 minutes\\. Check back soon\\!',
        { parse_mode: 'MarkdownV2' },
      );
      return;
    }

    let text = '🎯 *DeepBook Predict — BTC Binary Options*\n\n';
    const kb = new InlineKeyboard();

    for (let i = 0; i < Math.min(3, markets.length); i++) {
      const m = markets[i];
      const expiryDate = new Date(m.expiryMs);
      const expiryStr = expiryDate.toUTCString().slice(17, 25); // "HH:MM:SS"
      const minsLeft = Math.round((m.expiryMs - Date.now()) / 60000);
      const atmStrike = (m.spotPrice / m.tickSize) * m.tickSize;
      const strike = atmStrike >= m.minStrike ? atmStrike : m.minStrike;
      const strikeUsd = Number(strike) / 1e9;

      text +=
        `*Market ${i + 1}:* BTC/USD @ $${escMd(strikeUsd.toLocaleString())}\n` +
        `⏱ Expires: ${escMd(expiryStr)} UTC \\(${minsLeft}m\\)\n\n`;

      // Callback budget: 64 bytes. "pred:up:" (8) + 16 hex (16) + ":" (1) +
      // 10 digit unix seconds (10) = 35 bytes. Comfortably fits.
      const oracleShort = m.oracleId.slice(2, 18);
      const expirySec = Math.floor(m.expiryMs / 1000);

      kb.text(`📈 UP #${i + 1}`, `pred:up:${oracleShort}:${expirySec}`)
        .text(`📉 DOWN #${i + 1}`, `pred:dn:${oracleShort}:${expirySec}`)
        .row();
    }

    text += `💰 *Bet size:* 10 DUSDC per position`;
    kb.text('🔄 Refresh', 'pred:refresh');

    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
  } catch (err) {
    console.error('[predict] command error:', err);
    await ctx.reply('❌ Failed to load markets. Try again.');
  }
}

// ── Predict setup callback: verify DUSDC arrival, then surface OAuth URL ─────
// Callback format: prd:setup:PROFILE_ID  (≤ 64 bytes)
async function predictSetupCheckCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery?.data ?? '';
  const parts = data.split(':');
  if (parts.length < 3) { await ctx.reply('Invalid callback data.'); return; }
  const profileId = parts[2];

  // Look up tgHash via the TelegramUser linked to this profile.
  const tgUser = await prismaQuery.telegramUser.findFirst({
    where: { trader_profile_id: profileId },
    select: { telegram_user_id_hash: true },
  });
  const tgHash = tgUser?.telegram_user_id_hash ?? '';
  if (!tgHash) {
    await ctx.reply('Could not find your Telegram account. Please /start again.');
    return;
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      sui_address: true,
      balance_manager_id: true,
      predict_manager_id: true,
    },
  });
  if (!profile) {
    await ctx.reply('Profile not found. Please /start again.');
    return;
  }

  // If predict_manager_id was set between command and callback, skip the
  // setup flow — bounce the user straight to the market list.
  if (profile.predict_manager_id) {
    await ctx.reply(
      '✅ Your Predict account is already set up. Run /predict to see active markets.',
    );
    return;
  }

  // Verify DUSDC arrived at the user's bound address. We MUST use
  // getOwnedObjects with a StructType filter — the typed `getCoins` helper has
  // been observed silently returning empty for non-SUI coins on testnet.
  const dusdcStructType = `0x2::coin::Coin<${DUSDC_TYPE_TAG}>`;
  const ownedRpc = suiRpc as unknown as {
    getOwnedObjects: (params: {
      owner: string;
      filter?: { StructType?: string };
      options?: { showContent?: boolean };
    }) => Promise<OwnedCoinResp>;
  };

  let hasDusdc = false;
  let rpcError: string | null = null;
  try {
    const resp = await ownedRpc.getOwnedObjects({
      owner: profile.sui_address,
      filter: { StructType: dusdcStructType },
      options: { showContent: true },
    });
    hasDusdc = (resp.data ?? []).some((c) => {
      const bal = c.data?.content?.fields?.balance;
      return bal != null && BigInt(bal) >= PREDICT_DEFAULT_DEPOSIT_RAW;
    });
  } catch (e) {
    rpcError = (e as Error).message ?? String(e);
    console.error('[bot/predict-setup-check] DUSDC query failed:', e);
  }

  const dusdcHuman = (Number(PREDICT_DEFAULT_DEPOSIT_RAW) / 1e6).toFixed(0);
  if (rpcError !== null) {
    const cbData = `prd:setup:${profileId}`;
    const kb = new InlineKeyboard().text('🔄 Check Again', cbData);
    await ctx.reply(
      `⚠️ Could not reach the Sui RPC to verify your DUSDC balance.\n\n` +
        `If you have already sent ${dusdcHuman} DUSDC to:\n\`${profile.sui_address}\`\n\n` +
        `Tap Check Again in a moment.`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  if (!hasDusdc) {
    const cbData = `prd:setup:${profileId}`;
    const kb = new InlineKeyboard().text('🔄 Check Again', cbData);
    await ctx.reply(
      `⏳ ${dusdcHuman} DUSDC not detected yet at your Lighthouse address.\n\n` +
        `Make sure you sent *DUSDC* (not SUI) to:\n\`${profile.sui_address}\`\n\n` +
        `Wait a few seconds for the transaction to confirm, then tap Check Again.`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
    return;
  }

  // DUSDC confirmed — surface the OAuth URL.
  let oauthUrl: string;
  try {
    const flow = await buildTelegramOAuthFlow(tgHash, {
      action: 'predict_setup',
      action_meta: {
        traderProfileId: profileId,
        amountRaw: PREDICT_DEFAULT_DEPOSIT_RAW.toString(),
      },
    });
    oauthUrl = flow.oauthUrl;
  } catch (e) {
    console.error('[bot/predict-setup-check] OAuth build failed:', e);
    await ctx.reply('Could not generate sign-in link. Please try again or contact support.');
    return;
  }

  const kb = new InlineKeyboard().url(`🔐 Sign & Set Up Predict`, oauthUrl);
  await ctx.reply(
    `✅ ${dusdcHuman} DUSDC detected at your address!\n\n` +
      `Tap the button below to authorise the setup (opens your browser):\n` +
      `_You'll sign in with Google once. The next two transactions are sponsored._`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

interface OwnedCoinResp {
  data?: Array<{
    data?: {
      objectId?: string;
      version?: string;
      digest?: string;
      content?: { fields?: { balance?: string } };
    };
  }>;
}

async function predictActionCallback(ctx: Context): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data ?? '';
  await ctx.answerCallbackQuery();

  if (data === 'pred:refresh') {
    await predictCommand(ctx);
    return;
  }

  // Parse: pred:up:ORACLE16:EXPIRYSEC or pred:dn:ORACLE16:EXPIRYSEC
  const parts = data.split(':');
  if (parts.length !== 4) return;
  const [, direction, oracleShort, expirySec] = parts;
  const isUp = direction === 'up';
  const expiryMs = Number(expirySec) * 1000;

  // Block minting within 5 minutes of expiry to avoid the TOCTOU window where
  // Enoki's dry-run succeeds but the oracle settles before on-chain execution.
  const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
  if (expiryMs < Date.now() + EXPIRY_BUFFER_MS) {
    const expired = expiryMs < Date.now();
    await ctx.editMessageText(
      expired
        ? '⏰ This market has expired. Use /predict to see current markets.'
        : '⏰ This market closes in less than 5 minutes. Use /predict to find an open market.',
    );
    return;
  }

  // Resolve the user's profile + verify they have a PredictManager. The
  // helper replies to the user on failure, but it does so with `ctx.reply`,
  // not edit — fine for this two-message flow.
  const resolved = await resolveDepositProfile(ctx);
  if (!resolved) return;
  const { tgHash, profile } = resolved;

  if (!profile.predict_manager_id) {
    await ctx.editMessageText(
      '⚙️ You need to set up your Predict account first. Run /predict.',
    );
    return;
  }
  if (!PREDICT_OBJECT_ID) {
    await ctx.editMessageText(
      '❌ Predict is not configured. PREDICT_OBJECT_ID missing.',
    );
    return;
  }

  try {
    // Re-fetch markets (cached 30s) and match by oracle prefix.
    const markets = await getActiveMarkets(PREDICT_SERVER_URL, SUI_RPC_URL);
    const market = markets.find((m) => m.oracleId.includes(oracleShort));
    if (!market) {
      await ctx.editMessageText('❌ Market not found or expired. Use /predict to refresh.');
      return;
    }

    // Strike must be near spot, rounded to the nearest tick_size increment
    // above min_strike. Passing min_strike directly aborts the SVI pricing
    // model when spot has drifted far from the floor.
    const atmStrike = (market.spotPrice / market.tickSize) * market.tickSize;
    const strike = atmStrike >= market.minStrike ? atmStrike : market.minStrike;

    let oauthUrl: string;
    try {
      const flow = await buildTelegramOAuthFlow(tgHash, {
        action: 'predict_mint',
        action_meta: {
          traderProfileId: profile.id,
          predictObjectId: PREDICT_OBJECT_ID,
          oracleObjectId: market.oracleId,
          oracleInitialSharedVersion: market.oracleInitialSharedVersion,
          expiryMs: market.expiryMs.toString(),
          strike: strike.toString(),
          isUp,
          quantity: PREDICT_QUANTITY_RAW.toString(),
        },
      });
      oauthUrl = flow.oauthUrl;
    } catch (e) {
      console.error('[bot/predict-action] OAuth build failed:', e);
      await ctx.editMessageText(
        '❌ Could not generate sign-in link. Try again in a moment.',
      );
      return;
    }

    const strikeUsd = Number(strike) / 1e9;
    const expiryDate = new Date(market.expiryMs);
    const expiryStr = expiryDate.toUTCString().slice(17, 25);
    const dirText = isUp ? '📈 UP' : '📉 DOWN';

    const kb = new InlineKeyboard().url('🔐 Sign to Place Prediction', oauthUrl);
    await ctx.editMessageText(
      `🎯 *Confirm Prediction*\n\n` +
        `${dirText} on BTC/USD\n` +
        `💰 Strike: $${strikeUsd.toLocaleString()}\n` +
        `⏱ Expires: ${expiryStr} UTC\n` +
        `🏆 Payout if wins: 10 DUSDC\n` +
        `💸 Cost: ~50% of payout at market probability, deducted from PredictManager\n\n` +
        `_Tap below to sign with Google. Gas is sponsored — zero cost to you._`,
      { parse_mode: 'Markdown', reply_markup: kb },
    );
  } catch (err) {
    console.error('[predict] action error:', err);
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'Unknown error';
    await ctx.editMessageText(`❌ Could not start prediction flow: ${msg}`);
  }
}

