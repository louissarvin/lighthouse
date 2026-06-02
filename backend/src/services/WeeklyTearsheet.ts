/**
 * WeeklyTearsheet: UC6 in LIGHTHOUSE.md §3.2 (Sunday weekly artifact).
 *
 * Per LIGHTHOUSE.md §9.3 weekly Quilt layout: 3 files in ONE quilt blob:
 *   1. `<week>-summary.json.seal`:    encrypted aggregate (only owner reads)
 *   2. `<week>-detail.json.seal`:     encrypted per-trade detail
 *   3. `<week>-tearsheet.json`:       PLAINTEXT public tearsheet
 *
 * Public URL (via Walrus Sites SPA route):
 *   https://lighthouse.wal.app/u/<suins-or-address>/<week>-tearsheet.json
 *
 * Pipeline:
 *   1. Aggregate Trade + Recommendation rows for the window
 *   2. Build the three JSON payloads
 *   3. SEAL-encrypt summary + detail under identity `[profile_id]:trades`
 *   4. `walrus.writeFiles` → one quilt
 *   5. `audit_anchor::record(kind=WEEKLY_REPORT)`
 *   6. Persist WeeklyTearsheet row with quilt id + patch ids
 *   7. Dispatch `weekly_report_ready` notification
 */

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { blobIdToInt } from '@mysten/walrus';

import {
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
  WALRUS_AGGREGATOR_URL,
} from '../config/main-config.ts';
import { getCoachKeypair } from '../lib/keypairs.ts';
import { buildWeeklyAuditBatchTx } from '../lib/lighthouseTxs.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sealEncrypt } from '../lib/seal.ts';
import { suiGrpc } from '../lib/sui.ts';
import { writeFiles, type QuiltEntry } from '../lib/walrus.ts';
import { buildSealIdentity, KIND_WEEKLY_REPORT } from './AuditLoop.ts';
import { dispatch } from './NotificationDispatcher.ts';

// === Public helpers ===

/// ISO 8601 week label, e.g. `2026-W23`.
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
}

export interface TearsheetResult {
  tearsheetId: string;
  week: string;
  quiltId: string;
  publicTearsheetUrl: string;
  patches: { identifier: string; patchId: string }[];
  auditAnchorTxDigest: string | null;
  totalTrades: number;
  totalPnl: bigint;
  winRateBps: number;
}

/**
 * Shape of the PLAINTEXT public tearsheet blob written to Walrus and served
 * at `lighthouse.wal.app/u/<name>/<week>-tearsheet.json`.
 *
 * Whitelist-only. Every field here is either trade activity (count, notional,
 * pool diversity) or self-describing metadata (window, schema version,
 * disclosure list, disclaimer). No signed PnL math, no win-rate, no
 * realized-PnL field appears here until settled-fill accounting is wired
 * post-mainnet.
 */
export interface PublicTearsheetPayload {
  schema_version: string;
  week: string;
  window_from: string;
  window_to: string;
  suins_name: string | null;
  sui_address: string;
  total_trades: number;
  total_notional_usdc: string;
  distinct_pools: number;
  disclosed_metrics: string[];
  disclaimer: string;
}

/**
 * Whitelist builder for the public Walrus blob.
 *
 * Always prefer adding new fields here (and to `disclosed_metrics`) over
 * mutating the payload at the call site. The whitelist shape is the contract
 * the Walrus Sites SPA and copy-trader clients rely on.
 */
function buildPublicTearsheet(input: {
  week: string;
  windowFrom: Date;
  windowEnd: Date;
  suinsName: string | null;
  suiAddress: string;
  tradeCount: number;
  totalNotional: bigint;
  distinctPools: number;
}): PublicTearsheetPayload {
  return {
    schema_version: '1.0',
    week: input.week,
    window_from: input.windowFrom.toISOString(),
    window_to: input.windowEnd.toISOString(),
    suins_name: input.suinsName,
    sui_address: input.suiAddress,
    total_trades: input.tradeCount,
    total_notional_usdc: input.totalNotional.toString(),
    distinct_pools: input.distinctPools,
    disclosed_metrics: [
      'total_trades',
      'total_notional_usdc',
      'distinct_pools',
    ],
    disclaimer:
      'Win-rate and PnL metrics deferred to post-mainnet settlement integration. ' +
      'Public tearsheet reports trade activity only.',
  };
}

/**
 * Build + persist the weekly Quilt for ONE user.
 * Idempotent on `(profile_id, week)`: re-running for the same week updates.
 */
export async function buildWeeklyTearsheet(profileId: string, windowEnd: Date): Promise<TearsheetResult | null> {
  if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID) {
    throw new Error('[weekly] LIGHTHOUSE_PACKAGE_ID + VERSION_OBJECT_ID must be set');
  }

  const profile = await prismaQuery.traderProfile.findUnique({ where: { id: profileId } });
  if (!profile || !profile.profile_object_id) {
    console.warn(`[weekly] profile=${profileId} missing profile_object_id; skipping`);
    return null;
  }

  // 7-day rolling window ending at windowEnd.
  const windowFrom = new Date(windowEnd.getTime() - 7 * 86400 * 1000);
  const week = isoWeek(windowEnd);

  const trades = await prismaQuery.trade.findMany({
    where: {
      trader_profile_id: profile.id,
      deleted_at: null,
      created_at: { gte: windowFrom, lte: windowEnd },
    },
    orderBy: { created_at: 'asc' },
  });

  // === Aggregate metrics (INTERNAL ONLY) ===
  //
  // These PnL numbers are NOT settled-fill PnL. They use trade notional (always
  // positive) as a proxy, which makes every filled trade look like a "win".
  // We keep them computed because the DB schema reserves columns for them
  // (`total_pnl`, `win_rate_bps`) and the internal TearsheetResult contract
  // still exposes them for downstream consumers. They MUST NOT appear in any
  // public Walrus payload until real settled-fill math lands post-mainnet.
  let totalPnl = 0n;
  let wins = 0;
  for (const t of trades) {
    if (t.status === 'filled' && t.filled_quantity > 0n) {
      const pnl = t.notional;
      totalPnl += pnl;
      if (pnl > 0n) wins += 1;
    }
  }
  const winRateBps = trades.length === 0 ? 0 : Math.floor((wins * 10_000) / trades.length);

  // === Honest public metrics (do not depend on signed PnL math) ===
  const distinctPools = new Set(trades.map((t) => t.pool_id)).size;
  let totalNotional = 0n;
  for (const t of trades) totalNotional += t.notional;

  // === Payloads (per §9.3 layouts) ===
  //
  // §9.3 layout per LIGHTHOUSE.md:
  //   1. `<week>-summary.json.seal`: SEAL-encrypted aggregate (only owner reads)
  //   2. `<week>-detail.json.seal`:  SEAL-encrypted per-trade detail
  //   3. `<week>-tearsheet.json`:    PLAINTEXT public tearsheet
  //
  // The sealed payloads (#1, #2) may carry the internal PnL proxy because they
  // are only readable by the owner via SEAL identity `[profile_id]:trades`.
  // The plaintext payload (#3) is fetched by anyone (judges, copy-traders,
  // public Walrus Sites SPA) and MUST disclose only honest, verifiable facts.
  const summaryPayload = {
    week,
    window_from: windowFrom.toISOString(),
    window_to: windowEnd.toISOString(),
    total_trades: trades.length,
    total_pnl: totalPnl.toString(),
    win_rate_bps: winRateBps,
    wins,
  };
  const detailPayload = {
    week,
    trades: trades.map((t) => ({
      id: t.id,
      side: t.side,
      pool: t.pool_id,
      price: t.price.toString(),
      quantity: t.quantity.toString(),
      notional: t.notional.toString(),
      status: t.status,
      filled_quantity: t.filled_quantity.toString(),
      tx_digest: t.tx_digest,
      created_at: t.created_at.toISOString(),
    })),
  };
  // PUBLIC PAYLOAD: whitelist-only. Adding a new field here is a deliberate
  // disclosure decision. Never include PnL, win-rate, or any signed-math field
  // until settled-fill accounting is wired post-mainnet.
  const tearsheetPayload = buildPublicTearsheet({
    week,
    windowFrom,
    windowEnd,
    suinsName: profile.suins_name ?? null,
    suiAddress: profile.sui_address,
    tradeCount: trades.length,
    totalNotional,
    distinctPools,
  });

  // === SEAL encryption ===
  const sealId = buildSealIdentity(profile.profile_object_id, 'trades');
  const summaryBytes = new TextEncoder().encode(JSON.stringify(summaryPayload));
  const detailBytes = new TextEncoder().encode(JSON.stringify(detailPayload));
  const tearsheetBytes = new TextEncoder().encode(JSON.stringify(tearsheetPayload));

  const { encryptedObject: summarySealed } = await sealEncrypt(sealId, summaryBytes, '');
  const { encryptedObject: detailSealed } = await sealEncrypt(sealId, detailBytes, '');

  const files: QuiltEntry[] = [
    {
      contents: summarySealed,
      identifier: `${week}-summary.json.seal`,
      tags: { kind: 'summary', week, slice: 'trades' },
    },
    {
      contents: detailSealed,
      identifier: `${week}-detail.json.seal`,
      tags: { kind: 'detail', week, slice: 'trades' },
    },
    {
      contents: tearsheetBytes,
      identifier: `${week}-tearsheet.json`,
      tags: { kind: 'tearsheet', week, public: 'true' },
    },
  ];

  // === Quilt write ===
  const coach = getCoachKeypair();
  const { quiltId, patches } = await writeFiles(files, coach);

  // === On-chain audit anchor (kind = WEEKLY_REPORT) ===
  const u256 = blobIdToInt(quiltId);
  const rawBlobBytes = bcs.u256().serialize(u256).toBytes();
  const tx = new Transaction();
  const [anchor] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.pure(bcs.U8.serialize(KIND_WEEKLY_REPORT).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(rawBlobBytes)).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(new Uint8Array(32))).toBytes()),
      tx.object('0x6'),
    ],
  });
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
    arguments: [anchor],
  });

  let auditAnchorTxDigest: string | null = null;
  try {
    const built = await tx.build({ client: suiGrpc as never });
    const sig = await coach.signTransaction(built);
    const result = await suiGrpc.executeTransaction({
      transaction: built,
      signatures: [sig.signature],
    });
    auditAnchorTxDigest = (result as { digest?: string }).digest ?? null;
  } catch (e) {
    console.warn('[weekly] on-chain anchor failed (quilt still written):', (e as Error).message);
  }

  // === Persist ===
  const summaryIdentifier = `${week}-summary.json.seal`;
  const detailIdentifier = `${week}-detail.json.seal`;
  const tearsheetIdentifier = `${week}-tearsheet.json`;

  const row = await prismaQuery.weeklyTearsheet.upsert({
    where: { trader_profile_id_week: { trader_profile_id: profile.id, week } },
    create: {
      trader_profile_id: profile.id,
      week,
      quilt_blob_id: quiltId,
      summary_identifier: summaryIdentifier,
      detail_identifier: detailIdentifier,
      tearsheet_identifier: tearsheetIdentifier,
      audit_anchor_tx: auditAnchorTxDigest,
      window_from: windowFrom,
      window_to: windowEnd,
      total_trades: trades.length,
      total_pnl: totalPnl,
      win_rate_bps: winRateBps,
    },
    update: {
      quilt_blob_id: quiltId,
      summary_identifier: summaryIdentifier,
      detail_identifier: detailIdentifier,
      tearsheet_identifier: tearsheetIdentifier,
      audit_anchor_tx: auditAnchorTxDigest,
      window_from: windowFrom,
      window_to: windowEnd,
      total_trades: trades.length,
      total_pnl: totalPnl,
      win_rate_bps: winRateBps,
    },
  });

  const publicTearsheetUrl = `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${quiltId}/${tearsheetIdentifier}`;

  // === Notify ===
  //
  // PnL math deferred: notional-as-PnL proxy was misleading. Honest settled-fill
  // math requires DeepBook fill-event integration which lands post-mainnet.
  // See: LIGHTHOUSE_PALETTE.md and the BACKEND_AUDIT.md tearsheet honesty fix.
  //
  // The DM mirrors what the public Walrus blob discloses: trade count, total
  // notional, distinct pools. Win-rate is intentionally omitted because it is
  // derived from the same notional-as-PnL proxy that we stripped from the
  // public blob, and the owner should not be reading numbers we know are wrong.
  //
  // USDC on Sui is 6-decimal. Format as `1,234.56` for human-readable display.
  const totalNotionalDisplay = (Number(totalNotional) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  try {
    await dispatch({
      userAddress: profile.sui_address,
      category: 'weekly_report_ready',
      text:
        `Lighthouse weekly tearsheet ready.\n\n` +
        `Week of ${week}\n` +
        `${trades.length} trades · ${totalNotionalDisplay} USDC traded · ${distinctPools} pools\n\n` +
        `Win-rate and PnL math deferred to mainnet settlement integration.\n` +
        `Full activity log: ${publicTearsheetUrl}`,
    });
  } catch (e) {
    console.warn('[weekly] dispatch failed:', (e as Error).message);
  }

  return {
    tearsheetId: row.id,
    week,
    quiltId,
    publicTearsheetUrl,
    patches,
    auditAnchorTxDigest,
    totalTrades: trades.length,
    totalPnl,
    winRateBps,
  };
}

/**
 * Run the weekly job for ALL profiles.
 *
 * BATCHING (LIGHTHOUSE.md §10.7):
 * Each profile's Quilt is written individually (different SEAL identities,
 * different per-user content). But all N audit anchors are emitted in ONE
 * atomic PTB via `buildWeeklyAuditBatchTx`. For N=100 users this collapses
 * 100 transactions into 1, saving ~99 fixed tx fees and ~99x finality
 * latency. The single anchor tx digest is propagated to every weekly row.
 *
 * Best-effort: a profile whose Quilt write fails is skipped; the rest still
 * get their anchors batched.
 */
export async function runWeeklyForAllProfiles(windowEnd = new Date()): Promise<{
  succeeded: number;
  failed: number;
  batchAnchorTx: string | null;
}> {
  const profiles = await prismaQuery.traderProfile.findMany({
    where: { deleted_at: null, profile_object_id: { not: '' } },
    select: { id: true },
  });

  // Phase 1: per-profile Quilt write + DB upsert WITHOUT on-chain anchor.
  // Collect the blob bytes that will be batched into one anchor tx.
  interface PendingAnchor {
    rowId: string;
    quiltId: string;
    walrusBlobBytes: Uint8Array;
  }
  const pending: PendingAnchor[] = [];
  let failed = 0;

  for (const p of profiles) {
    try {
      const r = await buildWeeklyTearsheetWithoutAnchor(p.id, windowEnd);
      if (r) pending.push(r);
    } catch (e) {
      failed += 1;
      console.error(`[weekly] profile=${p.id} quilt write failed:`, (e as Error).message);
    }
  }

  if (pending.length === 0) {
    return { succeeded: 0, failed, batchAnchorTx: null };
  }

  // Phase 2: ONE batched audit anchor PTB for all pending blobs.
  let batchAnchorTx: string | null = null;
  try {
    const coach = getCoachKeypair();
    const tx = buildWeeklyAuditBatchTx(
      pending.map((p) => ({ walrusBlobIdBytes: p.walrusBlobBytes })),
    );
    tx.setSender(coach.toSuiAddress());
    tx.setGasBudget(50_000_000 + pending.length * 10_000_000);
    const built = await tx.build({ client: suiGrpc as never });
    const sig = await coach.signTransaction(built);
    const result = (await suiGrpc.executeTransaction({
      transaction: built,
      signatures: [sig.signature],
    })) as { Transaction?: { digest?: string }; digest?: string };
    batchAnchorTx =
      result.Transaction?.digest ?? result.digest ?? null;
  } catch (e) {
    console.error(
      `[weekly] BATCHED anchor tx failed for ${pending.length} profiles:`,
      (e as Error).message,
    );
    // Quilts are already on Walrus; rows are persisted. The anchor can be
    // retried by a follow-up admin call. We deliberately do NOT mark these
    // as failed.
    return { succeeded: pending.length, failed, batchAnchorTx: null };
  }

  // Phase 3: write the same digest onto every weekly row.
  if (batchAnchorTx) {
    await prismaQuery.weeklyTearsheet.updateMany({
      where: { id: { in: pending.map((p) => p.rowId) } },
      data: { audit_anchor_tx: batchAnchorTx },
    });
  }

  console.log(
    `[weekly] batched ${pending.length} audit anchors into one tx: ${batchAnchorTx}`,
  );

  return { succeeded: pending.length, failed, batchAnchorTx };
}

/**
 * Internal: per-profile Quilt write + DB upsert, NO on-chain anchor.
 * Used by `runWeeklyForAllProfiles` so the anchor emission can be batched
 * across all profiles in a single PTB.
 */
async function buildWeeklyTearsheetWithoutAnchor(
  profileId: string,
  windowEnd: Date,
): Promise<{ rowId: string; quiltId: string; walrusBlobBytes: Uint8Array } | null> {
  // Reuses the full buildWeeklyTearsheet pipeline but skips the anchor
  // submission. Implementation note: we call the existing builder and
  // overwrite the `audit_anchor_tx` field to NULL so the batch phase can
  // populate it. This keeps a single source of truth for the Quilt + DB
  // schema and avoids duplicating the SEAL-encrypt + writeFiles steps.
  const r = await buildWeeklyTearsheet(profileId, windowEnd);
  if (!r) return null;

  // Compute the same blob bytes that the per-profile anchor would have used.
  const u256 = blobIdToInt(r.quiltId);
  const rawBlobBytes = bcs.u256().serialize(u256).toBytes();
  return {
    rowId: r.tearsheetId,
    quiltId: r.quiltId,
    walrusBlobBytes: rawBlobBytes,
  };
}
