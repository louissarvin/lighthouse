/**
 * Public tearsheet routes — UC6 read side.
 *
 * The Walrus Sites SPA at `lighthouse.wal.app/u/<name>/<week>-tearsheet.json`
 * reads the same data via the aggregator directly. These backend routes are
 * the convenience surface for clients that prefer JSON-over-HTTP without
 * touching Walrus directly.
 *
 *   GET /tearsheet/by-suins/:name/:week
 *     → resolves <name>.sui to a Sui address, looks up the user's
 *       TraderProfile, finds the matching WeeklyTearsheet row, returns
 *       the public Walrus URL + the rendered plaintext tearsheet JSON.
 *
 *   GET /tearsheet/by-address/:address/:week
 *     → direct address path, same shape.
 *
 *   GET /tearsheet/list/:address
 *     → list all available weeks for an address.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { WALRUS_AGGREGATOR_URL } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { resolveSuiNS } from '../lib/suins.ts';
import { readQuiltFile } from '../lib/walrus.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { buildWeeklyTearsheet, isoWeek } from '../services/WeeklyTearsheet.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
} from '../utils/errorHandler.ts';

export const tearsheetRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get('/by-suins/:name/:week', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name, week } = request.params as { name: string; week: string };
    if (!name || !week) return handleError(reply, 400, 'missing name or week', 'MISSING_PARAM');
    try {
      const address = await resolveSuiNS(name);
      if (!address) return handleNotFoundError(reply, `SuiNS name "${name}"`);
      return await serveTearsheet(reply, address, week);
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  // ─── GET /tearsheet/by-suins/:name/latest ──────────────────────────────
  // Convenience for shareable URLs (`/u/<name>`). Resolves the most recent
  // WeeklyTearsheet for the SuiNS-resolved address and proxies to the
  // standard tearsheet shape. We can't piggy-back on the existing
  // `/:name/:week` route because `latest` would be interpreted as a literal
  // week label like `2026-W23`.
  app.get(
    '/by-suins/:name/latest',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      if (!name) return handleError(reply, 400, 'missing name', 'MISSING_PARAM');
      try {
        const address = await resolveSuiNS(name);
        if (!address) return handleNotFoundError(reply, `SuiNS name "${name}"`);
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { sui_address: address },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');
        const latest = await prismaQuery.weeklyTearsheet.findFirst({
          where: { trader_profile_id: profile.id, deleted_at: null },
          orderBy: { window_to: 'desc' },
          select: { week: true },
        });
        if (!latest) return handleNotFoundError(reply, 'WeeklyTearsheet (any)');
        return await serveTearsheet(reply, address, latest.week);
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.get(
    '/by-address/:address/:week',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { address, week } = request.params as { address: string; week: string };
      if (!address || !week) {
        return handleError(reply, 400, 'missing address or week', 'MISSING_PARAM');
      }
      try {
        return await serveTearsheet(reply, address, week);
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.get('/list/:address', async (request: FastifyRequest, reply: FastifyReply) => {
    const { address } = request.params as { address: string };
    if (!address) return handleError(reply, 400, 'missing address', 'MISSING_PARAM');
    try {
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { sui_address: address },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      // PnL math deferred: notional-as-PnL proxy was misleading. Honest settled-fill
      // math requires DeepBook fill-event integration which lands post-mainnet.
      // See: LIGHTHOUSE_PALETTE.md and the BACKEND_AUDIT.md tearsheet honesty fix.
      //
      // Whitelist DB columns explicitly. Never select the legacy PnL or
      // proxy-win-rate columns for the public list response. Those columns
      // still exist on the row for owner-only SEAL-encrypted consumption.
      const tearsheets = await prismaQuery.weeklyTearsheet.findMany({
        where: { trader_profile_id: profile.id, deleted_at: null },
        orderBy: { window_to: 'desc' },
        select: {
          week: true,
          quilt_blob_id: true,
          tearsheet_identifier: true,
          total_trades: true,
          window_from: true,
          window_to: true,
          audit_anchor_tx: true,
          created_at: true,
        },
      });
      return reply.code(200).send({
        success: true,
        error: null,
        data: tearsheets.map((t) => ({
          week: t.week,
          walrus_blob_id: t.quilt_blob_id,
          total_trades: t.total_trades,
          window_from: t.window_from,
          window_to: t.window_to,
          auditAnchorTxDigest: t.audit_anchor_tx,
          createdAt: t.created_at,
          publicTearsheetUrl: `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${t.quilt_blob_id}/${t.tearsheet_identifier}`,
        })),
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  // ─── POST /tearsheet/build-now ─────────────────────────────────────────
  //
  // Manually trigger a weekly tearsheet generation for the authed user.
  // Reuses `buildWeeklyTearsheet(profileId, windowEnd)` from
  // `services/WeeklyTearsheet.ts` so the SEAL+Walrus+anchor pipeline is a
  // single source of truth shared with the Sunday cron worker (DRY).
  //
  // Idempotent: when a WeeklyTearsheet row already exists for
  // (trader_profile_id, week) we return the persisted row with
  // `alreadyGenerated: true` instead of re-running the full pipeline. The
  // worker's `upsert` would otherwise blow ~$0.01 of WAL on a duplicate
  // quilt write on every click.
  //
  // Security:
  //   - JWT cookie OR Authorization: Bearer required (authMiddleware).
  //   - Rate-limited 1 / 60s per user. Anchored to the JWT-derived
  //     trader_profile_id so a user can't bypass by hopping IPs (key
  //     fallback to IP for unauthenticated probes that race past the
  //     middleware, which should never happen in practice).
  //   - Returns 502 if Walrus aggregator/publisher is unreachable, 504 if
  //     the on-chain anchor times out. Other unknown errors → 500 via
  //     handleServerError (generic message, server-side log).
  //
  // Response: {
  //   alreadyGenerated, week, walrusBlobId, publicTearsheetUrl,
  //   auditAnchorTxDigest, totalTrades, windowFrom?, windowTo?
  // }
  app.post(
    '/build-now',
    {
      preHandler: [authMiddleware],
      // Fastify rate-limit honors per-route `keyGenerator` so we can scope
      // by trader_profile_id rather than IP. 1 request per 60s per user.
      config: {
        rateLimit: {
          max: 1,
          timeWindow: '60 seconds',
          keyGenerator: (req) => {
            const u = (req as FastifyRequest).user;
            return u?.trader_profile_id ?? req.ip;
          },
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            week: { type: 'string', pattern: '^[0-9]{4}-W[0-9]{2}$' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no trader_profile bound', 'NO_PROFILE');
      }
      const body = (request.body ?? {}) as { week?: string };
      const week = body.week ?? isoWeek(new Date());

      // Resolve windowEnd to a Date that, when passed through `isoWeek`,
      // produces the requested label. For the default (current week) we use
      // `now` directly. For an explicit historical week we parse the
      // YYYY-Www label back to the Thursday of that ISO week (canonical
      // anchor day per ISO 8601). The weekly pipeline uses a 7-day rolling
      // window ending at windowEnd, so anchoring at the Sunday following
      // the ISO Thursday gives us a stable, well-defined window for any
      // historical replay.
      let windowEnd: Date;
      if (body.week) {
        const parsed = parseIsoWeekToWindowEnd(week);
        if (!parsed) {
          return handleError(reply, 400, 'invalid week label', 'BAD_WEEK');
        }
        windowEnd = parsed;
      } else {
        windowEnd = new Date();
      }

      try {
        // Idempotency: check for an existing row BEFORE running the pipeline.
        // Avoids burning Walrus storage + on-chain gas on a duplicate click.
        const existing = await prismaQuery.weeklyTearsheet.findUnique({
          where: {
            trader_profile_id_week: {
              trader_profile_id: user.trader_profile_id,
              week,
            },
          },
        });
        if (existing) {
          const publicTearsheetUrl = `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${existing.quilt_blob_id}/${existing.tearsheet_identifier}`;
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              alreadyGenerated: true,
              week: existing.week,
              walrusBlobId: existing.quilt_blob_id,
              publicTearsheetUrl,
              auditAnchorTxDigest: existing.audit_anchor_tx,
              totalTrades: existing.total_trades,
              windowFrom: existing.window_from.toISOString(),
              windowTo: existing.window_to.toISOString(),
            },
          });
        }

        const result = await buildWeeklyTearsheet(
          user.trader_profile_id,
          windowEnd,
        );
        if (!result) {
          return handleError(
            reply,
            404,
            'profile missing on-chain TraderProfile object',
            'PROFILE_NOT_ONCHAIN',
          );
        }

        // Resolve window_from/window_to from the persisted row so the
        // response is authoritative even when the upstream pipeline mutates
        // the window (e.g. for short-history replay).
        const row = await prismaQuery.weeklyTearsheet.findUnique({
          where: {
            trader_profile_id_week: {
              trader_profile_id: user.trader_profile_id,
              week: result.week,
            },
          },
          select: { window_from: true, window_to: true },
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            alreadyGenerated: false,
            week: result.week,
            walrusBlobId: result.quiltId,
            publicTearsheetUrl: result.publicTearsheetUrl,
            auditAnchorTxDigest: result.auditAnchorTxDigest,
            totalTrades: result.totalTrades,
            windowFrom: row?.window_from.toISOString() ?? null,
            windowTo: row?.window_to.toISOString() ?? null,
          },
        });
      } catch (e) {
        // Classify upstream failures so the frontend can render a useful
        // retry CTA. Walrus failures most often surface as fetch errors
        // from the publisher; on-chain anchor failures surface as RPC
        // timeouts. Anything else is a server bug → 500.
        const msg = (e as Error)?.message?.toLowerCase() ?? '';
        if (
          msg.includes('walrus') ||
          msg.includes('publisher') ||
          msg.includes('aggregator') ||
          msg.includes('econnrefused') ||
          msg.includes('enotfound')
        ) {
          return handleError(
            reply,
            502,
            'walrus unreachable',
            'WALRUS_UNREACHABLE',
            e as Error,
          );
        }
        if (
          msg.includes('timeout') ||
          msg.includes('timed out') ||
          msg.includes('deadline')
        ) {
          return handleError(
            reply,
            504,
            'anchor tx timed out',
            'ANCHOR_TX_TIMEOUT',
            e as Error,
          );
        }
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};

/**
 * Parse an ISO 8601 week label (`YYYY-Www`) into a Date that, when fed
 * through `isoWeek(date)`, round-trips back to the same label. We anchor on
 * the Thursday of that ISO week (the canonical anchor day per the ISO 8601
 * spec) and clamp time to 23:59:59 UTC so the rolling 7-day window inside
 * `buildWeeklyTearsheet` covers the full Monday-Sunday range.
 *
 * Returns `null` for malformed labels. The route's Fastify schema already
 * pattern-validates the label so this is a defense-in-depth check.
 */
function parseIsoWeekToWindowEnd(label: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
  if (week < 1 || week > 53) return null;
  // ISO 8601: week 1 is the week containing Jan 4th. The Thursday of week N
  // is `(Thursday of week 1) + (N-1) weeks`.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const thursdayOfWeek1 = new Date(jan4);
  thursdayOfWeek1.setUTCDate(jan4.getUTCDate() - jan4Dow + 3);
  const target = new Date(thursdayOfWeek1);
  target.setUTCDate(thursdayOfWeek1.getUTCDate() + (week - 1) * 7);
  // Clamp to end-of-day so the 7-day window inside buildWeeklyTearsheet
  // captures any trades stamped late in the day.
  target.setUTCHours(23, 59, 59, 999);
  return target;
}

// PnL math deferred: notional-as-PnL proxy was misleading. Honest settled-fill
// math requires DeepBook fill-event integration which lands post-mainnet.
// See: LIGHTHOUSE_PALETTE.md and the BACKEND_AUDIT.md tearsheet honesty fix.
//
// `serveTearsheet` returns an explicit whitelist of fields. Never spread the
// Prisma row (`...tearsheet`) into the response: the row still carries the
// legacy PnL and proxy-win-rate columns for owner-only SEAL-encrypted use,
// and a spread would re-leak them on the public surface. The honest activity
// metrics (`total_trades`, `total_notional_usdc`, `distinct_pools`) live on
// the parsed Walrus blob exposed via `tearsheet`.
async function serveTearsheet(
  reply: FastifyReply,
  suiAddress: string,
  week: string,
): Promise<FastifyReply> {
  const profile = await prismaQuery.traderProfile.findUnique({
    where: { sui_address: suiAddress },
  });
  if (!profile) return handleNotFoundError(reply, 'TraderProfile');
  const tearsheet = await prismaQuery.weeklyTearsheet.findUnique({
    where: { trader_profile_id_week: { trader_profile_id: profile.id, week } },
  });
  if (!tearsheet) return handleNotFoundError(reply, `WeeklyTearsheet ${week}`);

  const publicUrl = `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${tearsheet.quilt_blob_id}/${tearsheet.tearsheet_identifier}`;

  // Best-effort: pull the actual plaintext bytes from the aggregator so the
  // response is self-contained. Falls back to the URL if read fails.
  let tearsheetJson: unknown = null;
  try {
    const bytes = await readQuiltFile(tearsheet.quilt_blob_id, tearsheet.tearsheet_identifier);
    tearsheetJson = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    console.warn(`[tearsheet] aggregator read failed for ${tearsheet.quilt_blob_id}/${tearsheet.tearsheet_identifier}:`, (e as Error).message);
  }

  // Pull honest activity metrics from the parsed Walrus blob when available.
  // The blob is the source of truth for what is publicly disclosed; surfacing
  // these fields at the top level of `data` is a convenience for clients that
  // do not want to introspect the nested `tearsheet` payload.
  const blob = (tearsheetJson ?? {}) as Partial<{
    total_trades: number;
    total_notional_usdc: string;
    distinct_pools: number;
    disclaimer: string;
    window_from: string;
    window_to: string;
  }>;

  return reply.code(200).send({
    success: true,
    error: null,
    data: {
      week,
      suins_name: profile.suins_name,
      sui_address: suiAddress,
      walrus_blob_id: tearsheet.quilt_blob_id,
      publicTearsheetUrl: publicUrl,
      auditAnchorTxDigest: tearsheet.audit_anchor_tx,
      window_from: blob.window_from ?? tearsheet.window_from.toISOString(),
      window_to: blob.window_to ?? tearsheet.window_to.toISOString(),
      total_trades: blob.total_trades ?? tearsheet.total_trades,
      total_notional_usdc: blob.total_notional_usdc ?? null,
      distinct_pools: blob.distinct_pools ?? null,
      disclaimer:
        blob.disclaimer ??
        'Win-rate and PnL metrics deferred to post-mainnet settlement integration. ' +
          'Public tearsheet reports trade activity only.',
      tearsheet: tearsheetJson,
    },
  });
}
