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

  done();
};

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
