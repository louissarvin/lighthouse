/**
 * GET /activity/recent; public read of the last N on-chain events the
 * EventIndexer has persisted.
 *
 * Powers the `lighthouse.wal.app/activity` SPA page (LIGHTHOUSE_STACK_MAXIMIZATION.md
 * upgrade #2; the strongest single "alive on testnet" signal a judge can
 * verify in 10 seconds). Read-only mirror of the data already poured into
 * Postgres by `services/EventIndexer.ts`. We deliberately do NOT requery
 * Sui RPC here so the demo path stays decoupled from RPC latency.
 *
 * Event kind sourcing (no NEW indexer work; these are all pulled from
 * existing tables that the indexer or write-path code populates):
 *
 *   TraderProfileCreated → `TraderProfile` rows (created via /onboarding/finalise,
 *                          which mints the on-chain `trader_profile::TraderProfile`
 *                          shared object per LIGHTHOUSE.md §6.2).
 *   MemWalWrite          → `MemoryNamespace` rows with non-null `last_remember_at`
 *                          (LIGHTHOUSE.md §7.1; seven canonical MemWal namespaces).
 *   AnchorRecorded       → `WalrusBlob` rows (populated by EventIndexer's
 *                          handleAnchorRecorded for LIGHTHOUSE.md §6.4
 *                          `audit_anchor::AnchorRecorded` Move event).
 *   TradePlaced          → `Trade` rows (created in /sponsor/place-limit and
 *                          linked back via EventIndexer's handleTradeExecuted
 *                          per LIGHTHOUSE.md §10).
 *   GrantCreated         → currently un-persisted server-side; the
 *                          `trader_profile::grant_copy_trader` PTB is signed and
 *                          executed directly via Enoki and only lives on-chain.
 *                          Returned as zero rows until a dedicated event
 *                          indexer entry exists (TODO §6.2 GrantCreated).
 *
 * Security:
 *   - GET-only, public (data surfaced is already on-chain public testnet activity)
 *   - Rate-limited 60/min/IP (per BACKEND_AUDIT.md gap #5; judges WILL refresh)
 *   - Fastify schema validation rejects out-of-bounds `limit` (no silent clamp)
 *   - Prisma typed queries with explicit `select`; no `$queryRaw`, no row spread
 *   - Sui addresses + blob ids truncated in summary strings (no full-id leakage
 *     beyond the explicit `tx_digest` field which is already public on-chain)
 *   - No PII: telegram_user_id_hash, telegram_chat_id, ip, email all excluded
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { prismaQuery } from '../lib/prisma.ts';
import { handleServerError } from '../utils/errorHandler.ts';

// === Constants ===

/// Hard ceiling chosen to keep response payload small (~5 fields x 20 events
/// x 5 kinds ≈ 100 rows max) and discourage scraping via this endpoint.
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;
const SUMMARY_MAX_CHARS = 120;

// === Types ===

type ActivityKind =
  | 'TraderProfileCreated'
  | 'MemWalWrite'
  | 'AnchorRecorded'
  | 'TradePlaced'
  | 'GrantCreated';

interface ActivityEvent {
  kind: ActivityKind;
  tx_digest: string;
  timestamp_ms: number;
  summary: string;
  /// Optional deep-link target so the web UI can route to the
  /// `/receipt/<id>` page directly. Stable Prisma cuid for both kinds.
  /// AnchorRecorded → underlying Recommendation.id (when this WalrusBlob
  /// was written by /coach/anchor-reply or /coach/recommend); otherwise
  /// null because pure audit blobs without a backing recommendation
  /// row have no receipt surface yet.
  /// TradePlaced → Trade.id.
  receipt_id?: string | null;
  /// Optional explicit kind hint for the frontend so it can pick the
  /// correct /proof/<kind>/<id> route. Always 'recommendation' or 'trade'
  /// when receipt_id is present; null otherwise.
  receipt_kind?: 'recommendation' | 'trade' | null;
}

// === Helpers ===

/**
 * Truncate a 0x-prefixed Sui address / blob id to `0xabcd…wxyz` form. Never
 * leak the full id in user-facing summary strings; the dedicated `tx_digest`
 * field is the canonical reference.
 */
function shortId(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length <= 8) return raw;
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/// LIGHTHOUSE.md §6.4: audit_anchor kinds (0=recommendation, 1=trade, 2=weekly-report).
function kindLabel(kind: number | null): string {
  if (kind === 0) return 'recommendation';
  if (kind === 1) return 'trade';
  if (kind === 2) return 'weekly-tearsheet';
  return 'unknown';
}

/// Hard guarantee: every summary is <= SUMMARY_MAX_CHARS so a Telegram render
/// or screenshot crop never truncates mid-token.
function clamp(s: string): string {
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return s.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
}

// === Loaders (each returns at most `limit` rows for one kind) ===

async function loadTraderProfileCreated(limit: number): Promise<ActivityEvent[]> {
  // LIGHTHOUSE.md §6.2: trader_profile::create is the on-chain mint. The Sui
  // address column is whitelisted; we never select the optional `suins_name`
  // here because the SuiNS apex is user-controlled UTF-8 and would defeat
  // the address-truncation defense in summary strings.
  const rows = await prismaQuery.traderProfile.findMany({
    where: { deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      sui_address: true,
      profile_object_id: true,
      created_at: true,
    },
  });
  return rows.map((r) => ({
    kind: 'TraderProfileCreated' as const,
    // We don't persist the create-tx digest on the TraderProfile row; the
    // profile_object_id uniquely identifies the on-chain object and is what
    // an explorer link should resolve.
    tx_digest: r.profile_object_id,
    timestamp_ms: r.created_at.getTime(),
    summary: clamp(
      `TraderProfile ${shortId(r.profile_object_id)} created via zkLogin + Enoki sponsorship`,
    ),
  }));
}

async function loadMemWalWrites(limit: number): Promise<ActivityEvent[]> {
  // LIGHTHOUSE.md §7.1: MemWal writes happen across the seven canonical
  // namespaces. We approximate per-write events via `MemoryNamespace`
  // `last_remember_at` (one row per (profile, namespace)). Strict MemWal
  // append events live on the relayer, not on Sui, so this is the best
  // server-side proxy until a dedicated MemWal write log lands.
  const rows = await prismaQuery.memoryNamespace.findMany({
    where: { last_remember_at: { not: null } },
    orderBy: { last_remember_at: 'desc' },
    take: limit,
    select: {
      namespace: true,
      last_remember_at: true,
    },
  });
  return rows
    .filter((r): r is { namespace: string; last_remember_at: Date } => r.last_remember_at !== null)
    .map((r) => ({
      kind: 'MemWalWrite' as const,
      // MemWal writes do not produce a Sui tx; they hit Walrus directly via
      // the relayer. The namespace doubles as a stable identifier for the row.
      tx_digest: `memwal:${r.namespace}`,
      timestamp_ms: r.last_remember_at.getTime(),
      summary: clamp(
        `MemWal ${r.namespace} written to Walrus (encrypted blob via MemWal relayer)`,
      ),
    }));
}

async function loadAnchorRecorded(limit: number): Promise<ActivityEvent[]> {
  // LIGHTHOUSE.md §6.4: `audit_anchor::AnchorRecorded` is the Move event
  // populated by EventIndexer.handleAnchorRecorded. The WalrusBlob row is
  // the indexer's authoritative cache (per schema.prisma comment).
  const rows = await prismaQuery.walrusBlob.findMany({
    where: { deleted_at: null, tx_digest: { not: null } },
    orderBy: { registered_at: 'desc' },
    take: limit,
    select: {
      blob_id: true,
      tx_digest: true,
      size_bytes: true,
      kind: true,
      registered_at: true,
    },
  });
  const valid = rows.filter(
    (r): r is typeof r & { tx_digest: string } => r.tx_digest !== null,
  );

  // Best-effort join: a Walrus blob written via /coach/recommend or
  // /coach/anchor-reply carries a backing Recommendation row keyed by
  // `walrus_blob_id`. Resolve those so the timeline row links straight to
  // `/receipt/<recommendationId>`.
  //
  // Encoding caveat — WalrusBlob.blob_id is stored as the HEX of the UTF-8
  // bytes of the base64url string the Walrus client returned. The
  // EventIndexer does:
  //     Buffer.from(new Uint8Array(walrus_blob_id_bytes)).toString('hex')
  // and `anchorText`/`writeBlob` pass `new TextEncoder().encode(blobId)`
  // as the on-chain payload, so the round-trip is base64url → utf-8 → hex.
  // Recommendation.walrus_blob_id is stored as the raw base64url. We
  // therefore convert each recommendation's blob id back to its utf-8 hex
  // form for the JOIN; otherwise the formats mismatch and every row links
  // to nothing (silent failure mode).
  //
  // We do one batch fetch (`take: limit * 4` to over-sample, then map by
  // hex form) so the dominant cost stays a single Prisma read regardless
  // of how many anchors are in the window.
  const recCandidates = await prismaQuery.recommendation.findMany({
    where: { walrus_blob_id: { not: null }, deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: Math.max(limit * 4, 40),
    select: { id: true, walrus_blob_id: true },
  });
  const recIdByBlobHex = new Map<string, string>();
  for (const rec of recCandidates) {
    if (!rec.walrus_blob_id) continue;
    const utf8Hex = Buffer.from(rec.walrus_blob_id, 'utf8').toString('hex');
    recIdByBlobHex.set(utf8Hex, rec.id);
  }

  return valid.map((r) => {
    const label = kindLabel(r.kind);
    // `r.blob_id` is the hex form; the map keys are also hex.
    const recId = recIdByBlobHex.get(r.blob_id) ?? null;
    return {
      kind: 'AnchorRecorded' as const,
      tx_digest: r.tx_digest,
      timestamp_ms: r.registered_at.getTime(),
      summary: clamp(
        `AuditAnchor recorded for SEAL-encrypted Walrus blob ${shortId(r.blob_id)} (${label})`,
      ),
      receipt_id: recId,
      receipt_kind: recId ? ('recommendation' as const) : null,
    };
  });
}

async function loadTradePlaced(limit: number): Promise<ActivityEvent[]> {
  // LIGHTHOUSE.md §10: DeepBook v3 limit orders routed via the executor wrapper
  // (`executor::place_limit_under_budget`). The Trade row is created in
  // /sponsor/place-limit and the EventIndexer's handleTradeExecuted promotes
  // it to status='placed' with the on-chain order_id.
  const rows = await prismaQuery.trade.findMany({
    where: { deleted_at: null, tx_digest: { not: null } },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: {
      id: true,
      tx_digest: true,
      pool_id: true,
      side: true,
      price: true,
      quantity: true,
      created_at: true,
    },
  });
  return rows
    .filter((r): r is typeof r & { tx_digest: string } => r.tx_digest !== null)
    .map((r) => {
      const isBid = r.side === 'bid';
      return {
        kind: 'TradePlaced' as const,
        tx_digest: r.tx_digest,
        timestamp_ms: r.created_at.getTime(),
        summary: clamp(
          `DeepBook v3 limit order: pool ${shortId(r.pool_id)} ${isBid ? 'BUY' : 'SELL'} ` +
            `${r.quantity.toString()}@${r.price.toString()}, executor-gated`,
        ),
        receipt_id: r.id,
        receipt_kind: 'trade' as const,
      };
    });
}

async function loadGrantCreated(_limit: number): Promise<ActivityEvent[]> {
  // LIGHTHOUSE.md §6.2 + §8.4: `trader_profile::grant_copy_trader` mints a
  // SEAL grant for a copy-trader address. Currently NOT persisted server-side
  // (the PTB is sponsored + signed by the user and only the on-chain
  // copy_trader_granted_until table is authoritative). A future EventIndexer
  // entry for `GrantCreated` would populate this list. Returning an empty
  // array is the honest answer per BACKEND_AUDIT.md tearsheet-honesty rule.
  // TODO: add `lighthouse::trader_profile::GrantCreated` Move event +
  // EventIndexer handler, plus a Prisma `Grant` table, then surface here.
  return [];
}

// === Plugin ===

export const activityRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/recent',
    {
      // Fastify Ajv-backed schema validation. Out-of-bounds `limit` (e.g.
      // `?limit=99`) yields a 400 from Fastify before our handler runs ,
      // no silent clamping per the task brief.
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_LIMIT,
              default: DEFAULT_LIMIT,
            },
          },
        },
      },
      // Public read-heavy route; judges might refresh repeatedly. Per
      // BACKEND_AUDIT.md gap #5 a per-IP cap keeps a single misbehaving
      // client from drowning out everyone else.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { limit } = request.query as { limit: number };

      try {
        // Run the five loaders in parallel; independent queries on
        // independent tables, no shared transaction needed.
        const [profiles, memwals, anchors, trades, grants] = await Promise.all([
          loadTraderProfileCreated(limit),
          loadMemWalWrites(limit),
          loadAnchorRecorded(limit),
          loadTradePlaced(limit),
          loadGrantCreated(limit),
        ]);

        // Merge + sort descending by timestamp, then trim to `limit`. We
        // gather up to `5 * limit` rows worst case (one batch per kind) and
        // re-trim so the final response is bounded.
        const merged: ActivityEvent[] = [
          ...profiles,
          ...memwals,
          ...anchors,
          ...trades,
          ...grants,
        ]
          .sort((a, b) => b.timestamp_ms - a.timestamp_ms)
          .slice(0, limit);

        // total_indexed = AnchorRecorded count, the most defensible "this
        // is alive on testnet" metric (these are real on-chain Move events
        // the EventIndexer persisted via handleAnchorRecorded).
        const total_indexed = await prismaQuery.walrusBlob.count({
          where: { deleted_at: null },
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            events: merged,
            total_indexed,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
