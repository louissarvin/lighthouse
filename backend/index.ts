/**
 * Lighthouse backend entry point.
 *
 * Bootstraps Fastify + registers route plugins + spawns long-lived workers
 * (EventIndexer). Per LIGHTHOUSE.md §4.1 / §16.2 the backend houses:
 *   - CoachOrchestrator (routes/coachRoutes.ts)
 *   - EnokiSponsor      (routes/sponsorRoutes.ts)
 *   - TelegramAuth      (routes/authTelegramRoutes.ts)
 *   - EventIndexer      (services/EventIndexer.ts)
 *   - SettlementKeeper  (v2 stretch; not wired in v1)
 */

import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCookie from '@fastify/cookie';
import FastifyCors from '@fastify/cors';
import FastifyRateLimit from '@fastify/rate-limit';

import { APP_PORT, IS_DEV, JWT_SECRET, WEB_BASE_URL } from './src/config/main-config.ts';

// Routes
import { activityRoutes } from './src/routes/activityRoutes.ts';
import { agentRoutes } from './src/routes/agentRoutes.ts';
import { auditRoutes } from './src/routes/auditRoutes.ts';
import { authTelegramRoutes } from './src/routes/authTelegramRoutes.ts';
import { authWebRoutes } from './src/routes/authWebRoutes.ts';
import { coachRoutes } from './src/routes/coachRoutes.ts';
import { deepbookReadRoutes } from './src/routes/deepbookReadRoutes.ts';
import { dryRunRoutes } from './src/routes/dryRunRoutes.ts';
import { followRoutes } from './src/routes/followRoutes.ts';
import { leaderboardRoutes } from './src/routes/leaderboardRoutes.ts';
import { memwalRoutes } from './src/routes/memwalRoutes.ts';
import { messagingRoutes } from './src/routes/messagingRoutes.ts';
import { multiAgentRoutes } from './src/routes/multiAgentRoutes.ts';
import { oauthRoutes } from './src/routes/oauthRoutes.ts';
import { onboardingRoutes } from './src/routes/onboardingRoutes.ts';
import { predictRoutes } from './src/routes/predictRoutes.ts';
import { profileRoutes } from './src/routes/profileRoutes.ts';
import { proofRoutes } from './src/routes/proofRoutes.ts';
import { sponsorRoutes } from './src/routes/sponsorRoutes.ts';
import { statsRoutes } from './src/routes/statsRoutes.ts';
import { suinsRoutes } from './src/routes/suinsRoutes.ts';
import { tearsheetRoutes } from './src/routes/tearsheetRoutes.ts';
import { telegramWebhookRoutes } from './src/routes/telegramWebhookRoutes.ts';
import { tradeRoutes } from './src/routes/tradeRoutes.ts';
import { notificationRoutes } from './src/routes/notificationRoutes.ts';

// Workers
import { startAutoDepositSweeper, stopAutoDepositSweeper } from './src/workers/autoDepositSweeper.ts';
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startPredictSettlementWorker } from './src/workers/predictSettlementWorker.ts';
import { startWeeklyTearsheetWorker } from './src/workers/weeklyTearsheet.ts';
import { startEventIndexer, stopEventIndexer } from './src/services/EventIndexer.ts';
import { getTelegramBot } from './src/lib/telegramBot.ts';

console.log(
  '======================\n' +
    '  LIGHTHOUSE BACKEND\n' +
    '  testnet · v1\n' +
    '======================',
);

const fastify = Fastify({
  logger: IS_DEV,
});

// CORS; tighten before any production deploy.
//
// Dev: wide open for local frontend iteration.
// Prod: allow the Walrus Sites SPA (`*.wal.app`) to call the public
//       read-only routes (`/activity/recent`, `/api/stats`,
//       `/tearsheet/*`) without preflight failures. Mutating routes
//       (POSTs that touch Atoma / Enoki / Telegram) are protected by
//       their own rate limits + auth middleware so the broader allow-list
//       does not widen the attack surface beyond the GET surface.
// Cookie plugin must register BEFORE any route reads request.cookies. Required
// by the web SPA auth flow (lh_jwt httpOnly cookie set by /auth/web/set-cookie).
fastify.register(FastifyCookie, {
  secret: JWT_SECRET, // signed cookies (currently unused; reserved for csrf)
});

// CORS; tighten before any production deploy.
//
// Dev: wide open for local frontend iteration.
// Prod: allow the Walrus Sites SPA (`*.wal.app`) and the configured WEB_BASE_URL
//       to call the public read-only routes (`/activity/recent`, `/api/stats`,
//       `/tearsheet/*`) without preflight failures. Mutating routes
//       (POSTs that touch Atoma / Enoki / Telegram) are protected by
//       their own rate limits + auth middleware so the broader allow-list
//       does not widen the attack surface beyond the GET surface.
//
// `credentials: true` is REQUIRED so the SPA's `fetch(..., {credentials: 'include'})`
// successfully includes the `lh_jwt` httpOnly cookie cross-origin. Wildcard
// `origin: '*'` is incompatible with credentials in dev — we echo the request
// origin instead.
const webBaseUrlForCors = (() => {
  try {
    return new URL(WEB_BASE_URL).origin;
  } catch {
    return '';
  }
})();
fastify.register(FastifyCors, {
  origin: IS_DEV
    ? (origin, cb) => cb(null, origin ?? true)
    : (origin, cb) => {
        // null/undefined = same-origin or non-browser client (curl). Allow.
        if (!origin) return cb(null, true);
        // Walrus Sites apex + subdomain (e.g. lighthouse.wal.app).
        if (/^https:\/\/([a-z0-9-]+\.)?wal\.app$/i.test(origin)) return cb(null, true);
        // Explicit WEB_BASE_URL (handles custom domains).
        if (webBaseUrlForCors && origin === webBaseUrlForCors) return cb(null, true);
        return cb(null, false);
      },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token'],
});

// Rate limiting (per-route opt-in via `config.rateLimit`).
//
// `global: false` => routes have NO limit unless they explicitly opt in. This
// is safer than a global cap for routes like /coach/chat SSE that need to
// stream tokens for minutes. Routes that touch paid resources (Atoma quota,
// Enoki sponsored gas, Telegram webhook) MUST opt in. See:
//   - /tg/webhook                src/routes/telegramWebhookRoutes.ts
//   - /coach/recommend           src/routes/coachRoutes.ts
//   - /sponsor/execute           src/routes/sponsorRoutes.ts
// TODO (follow-up): add per-route limits to /onboarding/build-tx,
//   /onboarding/finalise, /sponsor/place-limit, /memwal/begin, /memwal/step2,
//   /auth/telegram/verify. See BACKEND_AUDIT.md gap #5.
fastify.register(FastifyRateLimit, {
  global: false,
  max: 100,
  timeWindow: '1 minute',
  // Key on remote IP. Fastify resolves `req.ip` via `X-Forwarded-For` when
  // `trustProxy` is enabled; for v1 we run behind a single tunnel/LB so the
  // raw socket IP is fine. Behind multi-hop infra, set `trustProxy: true` on
  // the Fastify constructor or `keyGenerator` will lump everyone together.
  keyGenerator: (req) => req.ip,
});

// Health check
fastify.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    error: null,
    data: { service: 'lighthouse-backend', status: 'ok', timestamp: new Date().toISOString() },
  });
});

// Route groups
fastify.register(authTelegramRoutes, { prefix: '/auth/telegram' });
fastify.register(authWebRoutes, { prefix: '/auth/web' });
fastify.register(oauthRoutes, { prefix: '/oauth' });
fastify.register(onboardingRoutes, { prefix: '/onboarding' });
fastify.register(profileRoutes, { prefix: '/profile' });
fastify.register(coachRoutes, { prefix: '/coach' });
fastify.register(sponsorRoutes, { prefix: '/sponsor' });
fastify.register(memwalRoutes, { prefix: '/memwal' });
fastify.register(multiAgentRoutes, { prefix: '/multi-agent' });
fastify.register(agentRoutes, { prefix: '/agent' });
fastify.register(predictRoutes, { prefix: '/predict' });
fastify.register(messagingRoutes, { prefix: '/messaging' });
fastify.register(dryRunRoutes, { prefix: '/sponsor' });
fastify.register(suinsRoutes, { prefix: '/suins' });
fastify.register(tearsheetRoutes, { prefix: '/tearsheet' });
fastify.register(proofRoutes, { prefix: '/proof' });
fastify.register(telegramWebhookRoutes, { prefix: '/tg' });
fastify.register(deepbookReadRoutes, { prefix: '/deepbook' });
// Public read-only surface for the StatsStrip + /activity SPA page
// (LIGHTHOUSE_STACK_MAXIMIZATION.md upgrade #2; "alive on testnet" signal).
// Per-route rate limits live inside each plugin's route options.
fastify.register(activityRoutes, { prefix: '/activity' });
fastify.register(statsRoutes, { prefix: '/api' });
// Also expose stats plugin at the root so the web's WorkerPill (which polls
// `/stats/workers` directly per AppNav.tsx) lands on the same handler. We
// register twice rather than moving the prefix to keep the existing
// `/api/stats` URL stable for the StatsStrip and any external integrations.
fastify.register(statsRoutes);
fastify.register(tradeRoutes, { prefix: '/trade' });
fastify.register(notificationRoutes, { prefix: '/notifications' });
fastify.register(auditRoutes, { prefix: '/audit' });
fastify.register(followRoutes, { prefix: '/follow' });
fastify.register(leaderboardRoutes, { prefix: '/leaderboard' });

const start = async (): Promise<void> => {
  try {
    // Cron workers
    startErrorLogCleanupWorker();
    startWeeklyTearsheetWorker();
    startPredictSettlementWorker();
    startAutoDepositSweeper();

    await fastify.listen({ port: APP_PORT, host: '0.0.0.0' });

    // Long-lived workers (start after Fastify is ready)
    void startEventIndexer();

    // Telegram bot: webhook is the production mode (handled by /tg/webhook
    // route). For local dev with no public URL, set TG_BOT_POLLING=1 to fall
    // back to long-polling.
    const bot = getTelegramBot();
    if (bot.enabled && process.env.TG_BOT_POLLING === '1') {
      void bot.startPolling();
    }

    const addr = fastify.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : APP_PORT;
    console.log(`[server] listening on http://localhost:${port}`);
  } catch (error) {
    console.error('[server] failed to start:', error);
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[server] received ${signal}, shutting down…`);
  stopEventIndexer();
  stopAutoDepositSweeper();
  const bot = getTelegramBot();
  if (bot.enabled) await bot.stop().catch((e) => console.error('[server] bot stop failed:', e));
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
