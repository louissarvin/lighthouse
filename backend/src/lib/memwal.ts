/**
 * MemWal client cache (per-account).
 *
 * Source: https://docs.memwal.ai/, memory/walrus_memwal_reverify_2026_06.md
 *
 * Each TraderProfile has its own MemWal account + delegate key (stored
 * server-side by us as the coach agent). One `MemWal` instance per account
 * is enough; we cache by `accountId`.
 *
 * Testnet relayer: https://relayer-staging.memory.walrus.xyz
 */

import { MemWal } from '@mysten-incubation/memwal';

import { MEMWAL_RELAYER_URL } from '../config/main-config.ts';

export interface MemWalCreateArgs {
  /// Bech32 or hex Ed25519 secret key for this account's delegate.
  delegateKey: string;
  /// On-chain MemWal account object ID.
  accountId: string;
  /// Optional default namespace (overridable per-call).
  namespace?: string;
}

const cache = new Map<string, MemWal>();

/**
 * Get-or-create a MemWal instance for an account. Cached per accountId.
 */
export async function getMemWal(args: MemWalCreateArgs): Promise<MemWal> {
  const existing = cache.get(args.accountId);
  if (existing) return existing;
  const m = await MemWal.create({
    key: args.delegateKey,
    accountId: args.accountId,
    serverUrl: MEMWAL_RELAYER_URL,
    namespace: args.namespace ?? 'lighthouse:trades',
  });
  cache.set(args.accountId, m);
  return m;
}

/**
 * Lighthouse's seven canonical namespaces — VERBATIM from LIGHTHOUSE.md §7.1.
 *
 * Spec footnote: namespaces are FLAT opaque strings with EXACT-equality
 * matching. Case-sensitive. The colon is a naming convention, not a hierarchy.
 * Any drift here silently breaks `recallAll` (queries find empty namespaces).
 */
export const NAMESPACES = {
  preferences: 'lighthouse:preferences',
  riskProfile: 'lighthouse:risk-profile',
  holdingsHistory: 'lighthouse:holdings-history',
  trades: 'lighthouse:trades',
  coachPersonality: 'lighthouse:coach-personality',
  lessonsLearned: 'lighthouse:lessons-learned',
  goals: 'lighthouse:goals',
} as const;
export type Namespace = (typeof NAMESPACES)[keyof typeof NAMESPACES];

/**
 * Persist a memory and wait until the relayer confirms indexing. Returns the
 * Walrus blob ID for use in `audit_anchor::record`.
 */
export async function rememberAndWait(
  account: MemWalCreateArgs,
  text: string,
  namespace?: string,
  timeoutMs = 60_000,
): Promise<{ blobId: string }> {
  const m = await getMemWal(account);
  const res = await m.rememberAndWait(text, namespace, { timeoutMs });
  return { blobId: res.blob_id };
}

/**
 * Semantic recall over a single namespace. To search ALL seven, issue 7
 * parallel calls (per §7.1: each `recall` matches one namespace).
 */
export interface RecallEntry {
  blobId: string;
  text: string;
  distance: number;
}

export async function recall(
  account: MemWalCreateArgs,
  query: string,
  namespace?: string,
  limit = 5,
  maxDistance?: number,
): Promise<RecallEntry[]> {
  const m = await getMemWal(account);
  const res = await m.recall({
    query,
    limit,
    ...(maxDistance !== undefined ? { maxDistance } : {}),
    ...(namespace ? { namespace } : {}),
  });
  return res.results.map((r) => ({
    blobId: r.blob_id,
    text: r.text,
    distance: r.distance,
  }));
}

/**
 * Recall across ALL seven Lighthouse namespaces in parallel. Returns a
 * flattened list of memories ordered by distance.
 */
export async function recallAll(
  account: MemWalCreateArgs,
  query: string,
  perNamespaceLimit = 3,
): Promise<RecallEntry[]> {
  const results = await Promise.all(
    Object.values(NAMESPACES).map((ns) => recall(account, query, ns, perNamespaceLimit)),
  );
  return results.flat().sort((a, b) => a.distance - b.distance);
}

/**
 * Cold-start: repopulate the relayer's local vector index for ONE namespace.
 * Per LIGHTHOUSE.md §7.4 "Backend cold-start sequence". Should be called for
 * each user's namespaces on process boot or first-recall-fail. Returns the
 * number of memories restored.
 */
export async function restoreNamespace(
  account: MemWalCreateArgs,
  namespace: string,
  limit = 100,
): Promise<number> {
  const m = await getMemWal(account);
  // `restore` shape varies across SDK versions; defensive narrow.
  const sdk = m as unknown as {
    restore?: (ns: string, limit?: number) => Promise<{ restored?: number; count?: number } | number>;
  };
  if (typeof sdk.restore !== 'function') {
    // Older SDK without restore — silently return 0 so callers can no-op.
    return 0;
  }
  const r = await sdk.restore(namespace, limit);
  if (typeof r === 'number') return r;
  return (r.restored ?? r.count ?? 0) as number;
}

/**
 * Restore ALL seven Lighthouse namespaces for an account. Safe to call on
 * process boot. Best-effort — failures per namespace are logged but do not
 * throw, so a misbehaving namespace doesn't block boot.
 */
export async function restoreAllNamespaces(
  account: MemWalCreateArgs,
  limit = 100,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const ns of Object.values(NAMESPACES)) {
    try {
      out[ns] = await restoreNamespace(account, ns, limit);
    } catch (e) {
      console.warn(`[memwal] restore(${ns}) failed:`, (e as Error).message);
      out[ns] = -1;
    }
  }
  return out;
}

/**
 * Convenience: persist a trade memory in the `lighthouse:trades` namespace.
 * Returns the Walrus blob ID for the AuditAnchor.record call.
 */
export async function rememberTrade(
  account: MemWalCreateArgs,
  text: string,
): Promise<{ blobId: string }> {
  return rememberAndWait(account, text, NAMESPACES.trades);
}

/**
 * MemWal v0.0.7 `analyzeAndWait` — server-side fact extraction + indexing in
 * one call. Higher-fidelity than `rememberAndWait` for trade narratives
 * because the relayer splits the input into multiple atomic facts before
 * embedding (better recall later).
 *
 * Pass `occurredAt` to anchor relative phrases ("earlier today") to the actual
 * trade execution timestamp — recall queries from a different timezone or
 * weeks later still resolve "yesterday" correctly.
 *
 * Source: `@mysten-incubation/memwal@0.0.7/dist/memwal.d.ts:247-251`
 *         `types.d.ts:138-183` (AnalyzeOptions, AnalyzeWaitResult).
 *
 * Returns the list of fact-level Walrus blob IDs (one per extracted fact).
 */
export interface AnalyzedFactResult {
  factText: string;
  factId: string;
  blobId: string | null;
}

export async function analyzeAndRemember(
  account: MemWalCreateArgs,
  narrative: string,
  namespace: string,
  occurredAt?: Date | string,
): Promise<AnalyzedFactResult[]> {
  const m = await getMemWal(account);
  const sdk = m as unknown as {
    analyzeAndWait?: (
      text: string,
      namespaceOrOptions?: string | { namespace?: string; occurredAt?: string | Date },
      opts?: { pollIntervalMs?: number; timeoutMs?: number },
    ) => Promise<{
      facts?: { text: string; id: string; blob_id?: string }[];
      results?: { id: string; blob_id?: string; namespace?: string }[];
    }>;
  };
  if (typeof sdk.analyzeAndWait !== 'function') {
    // SDK pre-0.0.7 — fall back to single rememberAndWait so callers keep
    // working without losing data.
    const r = await rememberAndWait(account, narrative, namespace);
    return [{ factText: narrative, factId: '', blobId: r.blobId }];
  }
  const occurredAtIso =
    occurredAt instanceof Date
      ? occurredAt.toISOString()
      : typeof occurredAt === 'string'
        ? occurredAt
        : undefined;
  const res = await sdk.analyzeAndWait(
    narrative,
    { namespace, ...(occurredAtIso ? { occurredAt: occurredAtIso } : {}) },
    { timeoutMs: 60_000 },
  );
  const facts = res.facts ?? [];
  // `results` array is index-aligned with `facts` per AnalyzeWaitResult
  // (extends RememberBulkResult). Join by ordering.
  return facts.map((f, i) => ({
    factText: f.text,
    factId: f.id,
    blobId: f.blob_id ?? res.results?.[i]?.blob_id ?? null,
  }));
}

/**
 * MemWal `rememberBulkAndWait` — batch up to 20 memories across any
 * namespaces in one call. Use for onboarding when we want to hydrate all 7
 * namespaces with initial seed memories.
 *
 * Source: `memwal.d.ts:116-126`, `types.d.ts:97-133`.
 */
export interface BulkItem {
  text: string;
  namespace: string;
}
export interface BulkResultItem {
  blobId: string | null;
  namespace: string;
  status: string;
}

export async function rememberBulk(
  account: MemWalCreateArgs,
  items: BulkItem[],
): Promise<BulkResultItem[]> {
  if (items.length === 0) return [];
  if (items.length > 20) {
    throw new Error('[memwal] rememberBulk accepts at most 20 items per call');
  }
  const m = await getMemWal(account);
  const sdk = m as unknown as {
    rememberBulkAndWait?: (
      items: { text: string; namespace?: string }[],
      opts?: { timeoutMs?: number },
    ) => Promise<{ results?: { blob_id?: string; namespace?: string; status?: string }[] }>;
  };
  if (typeof sdk.rememberBulkAndWait !== 'function') {
    // Fallback: serialize.
    const out: BulkResultItem[] = [];
    for (const item of items) {
      try {
        const r = await rememberAndWait(account, item.text, item.namespace);
        out.push({ blobId: r.blobId, namespace: item.namespace, status: 'done' });
      } catch (e) {
        out.push({ blobId: null, namespace: item.namespace, status: (e as Error).message });
      }
    }
    return out;
  }
  const res = await sdk.rememberBulkAndWait(items, { timeoutMs: 60_000 });
  return (res.results ?? []).map((r) => ({
    blobId: r.blob_id ?? null,
    namespace: r.namespace ?? '',
    status: r.status ?? 'unknown',
  }));
}

/**
 * Convenience: persist a recommendation memory in `lighthouse:trades` too —
 * coach rationale is part of the trade audit trail. Caller may choose a
 * different namespace if desired.
 */
export async function rememberRecommendation(
  account: MemWalCreateArgs,
  text: string,
  namespace: string = NAMESPACES.trades,
): Promise<{ blobId: string }> {
  return rememberAndWait(account, text, namespace);
}
