/**
 * Auto-deposit sweeper.
 *
 * Goal: eliminate the manual "I sent SUI / Confirm deposit" round-trip on the
 * web. The user creates a `PendingDeposit` intent row via
 * POST /agent/pending-deposit (which records `expected_sender_address`), sends
 * SUI to the public executor address, and this worker:
 *   1. polls recent inbound transactions to the executor every SWEEP_INTERVAL_MS
 *   2. for each inbound tx, finds the oldest 'awaiting' PendingDeposit whose
 *      `expected_sender_address` equals the actual on-chain sender AND whose
 *      `amount_mist <= incoming_amount_mist`, and which has not yet been
 *      claimed_from_tx_digest'd
 *   3. signs `deposit_with_cap` from the executor's gas coin into the user's
 *      BalanceManager (same call as /agent/deposit-instant)
 *   4. marks the row `swept` with the resulting tx digest, fires a notification
 *
 * SECURITY (C2 fix):
 *   - We no longer pick "any awaiting deposit that fits in our balance" — that
 *     allowed User A's older intent to harvest User B's incoming SUI. We now
 *     query the executor's inbound transfers (`queryTransactionBlocks` filtered
 *     `ToAddress = executor`), extract the actual sender via showInput, and
 *     match only against intents whose `expected_sender_address` matches.
 *   - `claimed_from_tx_digest` (with a UNIQUE constraint) ensures each inbound
 *     tx is consumed at most once across the table, even under retries.
 *
 * OPERATIONAL NOTES:
 *   - Single-process serialization is enforced via Postgres advisory lock
 *     (`pg_try_advisory_xact_lock`) keyed on the executor address. Multi-pod
 *     deploys MUST share the same Postgres instance for this to work.
 *   - The executor MUST hold enough SUI gas headroom — `SUI_GAS_RESERVE_MIST`
 *     is subtracted from balance before we consider funds "available".
 *   - We only scan transfers newer than INBOUND_LOOKBACK_MS. Reorgs deeper than
 *     that are not handled (acceptable for Sui's finality model).
 */

import cron from 'node-cron';

import { buildDepositTx } from '../lib/deepbook.ts';
import { getExecutorKeypair } from '../lib/keypairs.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { dispatch } from '../services/NotificationDispatcher.ts';
import { suiGrpc, suiRpc } from '../lib/sui.ts';

const SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

/// Reserve kept on the executor to pay gas for ALL its in-flight signed txs.
/// Bumped well above the 200M budget on /trade/place-as-agent so the sweeper
/// never out-competes the trade path for gas.
const SUI_GAS_RESERVE_MIST = 500_000_000n; // 0.5 SUI

/// How many recent inbound transactions to inspect per tick.
const INBOUND_SCAN_LIMIT = 25;

/// Stable 64-bit hash of the executor address, fed to pg_advisory_xact_lock.
/// Using FNV-1a 64-bit so the same address always maps to the same lock key
/// across process restarts.
function fnv1a64(s: string): bigint {
  // FNV offset basis (64-bit)
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  // Postgres advisory lock keys are signed bigint; convert from unsigned.
  if (hash >= 1n << 63n) hash -= 1n << 64n;
  return hash;
}

/// Sweep tick interval. 15s matches the spec.
const SWEEP_INTERVAL_MS = 15_000;
const SWEEP_CRON = '*/15 * * * * *'; // every 15s (6-field cron)

let isRunning = false;
let cronTask: cron.ScheduledTask | null = null;

// ─── Status tracking (consumed by GET /stats/workers) ──────────────────────
//
// Module-level mutable state updated on each tick. Exported via
// getAutoDepositSweeperStatus() so the worker stats endpoint can render an
// at-a-glance health view without coupling to internal Prisma rows.
let lastRunAtMs: number | null = null;
let lastRunDurationMs: number | null = null;
let lastTickOk: boolean = true;
let lastSweepedCount: number = 0;
let lastSweepedAmountMist: bigint = 0n;
let rateLimitedUntilMs: number | null = null;

/**
 * One sweep pass: process at most `MAX_CLAIMS_PER_TICK` claims to bound
 * worst-case tick duration.
 */
const MAX_CLAIMS_PER_TICK = 5;

async function expireStaleIntents(): Promise<void> {
  const now = new Date();
  try {
    const expired = await prismaQuery.pendingDeposit.updateMany({
      where: { status: 'awaiting', expected_by: { lt: now } },
      data: { status: 'expired' },
    });
    if (expired.count > 0) {
      console.log(`[autoDeposit] expired ${expired.count} stale intent(s)`);
    }
  } catch (e) {
    console.error('[autoDeposit] expire pass failed:', (e as Error).message);
  }
}

async function fetchExecutorBalanceMist(executorAddress: string): Promise<bigint> {
  const resp = await suiRpc.getBalance({
    owner: executorAddress,
    coinType: SUI_TYPE,
  });
  return BigInt(resp.totalBalance ?? '0');
}

interface InboundTransfer {
  /// On-chain tx digest of the inbound transfer.
  txDigest: string;
  /// The address that signed the inbound transfer (i.e. the depositor).
  senderAddress: string;
  /// Net positive SUI MIST credited to the executor in this tx.
  amountMist: bigint;
}

/**
 * Scan the executor's most recent inbound transactions and extract the
 * (sender, amount, digest) triples we need to match against pending intents.
 *
 * Uses suiRpc (JSON-RPC) because `queryTransactionBlocks` is the only API that
 * exposes `transaction.data.sender` + balance changes together in one call.
 */
async function fetchRecentInbound(executorAddress: string): Promise<InboundTransfer[]> {
  const page = await suiRpc.queryTransactionBlocks({
    filter: { ToAddress: executorAddress },
    options: { showInput: true, showBalanceChanges: true },
    limit: INBOUND_SCAN_LIMIT,
    order: 'descending',
  });

  const out: InboundTransfer[] = [];
  for (const tx of page.data) {
    if (!tx.digest) continue;
    // The `transaction` field carries the signed PTB; `data.sender` is the
    // single sender of that PTB.
    const sender = (
      tx.transaction as { data?: { sender?: string } } | undefined
    )?.data?.sender;
    if (!sender) continue;
    if (sender === executorAddress) {
      // Self-transfer / executor-signed tx; ignore.
      continue;
    }
    // Sum SUI balance changes credited TO the executor in this tx. There can
    // be multiple coin objects merged into the executor — we only count net
    // positive SUI deltas owned by the executor.
    let credited = 0n;
    for (const ch of tx.balanceChanges ?? []) {
      if (ch.coinType !== SUI_TYPE) continue;
      const ownerAddress =
        typeof ch.owner === 'object' && ch.owner !== null && 'AddressOwner' in ch.owner
          ? (ch.owner as { AddressOwner?: string }).AddressOwner
          : undefined;
      if (ownerAddress !== executorAddress) continue;
      try {
        const amt = BigInt(ch.amount);
        if (amt > 0n) credited += amt;
      } catch {
        // Skip malformed amount strings rather than crashing the tick.
        continue;
      }
    }
    if (credited <= 0n) continue;
    out.push({ txDigest: tx.digest, senderAddress: sender, amountMist: credited });
  }
  return out;
}

async function processOneSweep(): Promise<void> {
  const executor = getExecutorKeypair();
  const executorAddress = executor.toSuiAddress();
  const lockKey = fnv1a64(executorAddress);

  // Cheap pre-check: if the executor has no available SUI, skip the whole tick.
  let balance: bigint;
  try {
    balance = await fetchExecutorBalanceMist(executorAddress);
  } catch (e) {
    console.warn(
      '[autoDeposit] could not read executor balance:',
      (e as Error).message,
    );
    return;
  }
  const available = balance > SUI_GAS_RESERVE_MIST ? balance - SUI_GAS_RESERVE_MIST : 0n;
  if (available <= 0n) return;

  // Pull recent inbound transfers. If nothing arrived, nothing to do.
  let inbound: InboundTransfer[];
  try {
    inbound = await fetchRecentInbound(executorAddress);
  } catch (e) {
    console.warn(
      '[autoDeposit] inbound scan failed:',
      (e as Error).message,
    );
    return;
  }
  if (inbound.length === 0) return;

  // Filter out inbound txs we have already consumed.
  const inboundDigests = inbound.map((t) => t.txDigest);
  const alreadyClaimed = await prismaQuery.pendingDeposit.findMany({
    where: { claimed_from_tx_digest: { in: inboundDigests } },
    select: { claimed_from_tx_digest: true },
  });
  const claimedSet = new Set(
    alreadyClaimed
      .map((r) => r.claimed_from_tx_digest)
      .filter((d): d is string => !!d),
  );
  const unclaimed = inbound.filter((t) => !claimedSet.has(t.txDigest));
  if (unclaimed.length === 0) return;

  // Process oldest-first so a user who sent 10m ago gets credited before
  // one who sent 1m ago.
  unclaimed.reverse();

  let claimedTotalForGasCheck = 0n;
  let claimsThisTick = 0;

  for (const transfer of unclaimed) {
    if (claimsThisTick >= MAX_CLAIMS_PER_TICK) break;

    // Find the OLDEST awaiting intent that matches sender + fits this tx.
    const intent = await prismaQuery.pendingDeposit.findFirst({
      where: {
        status: 'awaiting',
        expected_sender_address: transfer.senderAddress,
        amount_mist: { lte: transfer.amountMist },
        claimed_from_tx_digest: null,
      },
      orderBy: { created_at: 'asc' },
    });
    if (!intent) continue;
    if (claimedTotalForGasCheck + intent.amount_mist > available) continue;

    const claimState: { didClaim: boolean; digest: string | null } = {
      didClaim: false,
      digest: null,
    };
    let claimError: string | null = null;

    try {
      await prismaQuery.$transaction(async (tx) => {
        const lockRow = (await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked
        `) as { locked: boolean }[];
        if (!lockRow[0]?.locked) {
          // Another sweeper holds the lock — bail out for this tick.
          return;
        }

        // Re-read the row inside the lock to confirm it's still awaiting and
        // still unclaimed (defensive against concurrent ticks).
        const fresh = await tx.pendingDeposit.findUnique({
          where: { id: intent.id },
        });
        if (!fresh || fresh.status !== 'awaiting' || fresh.claimed_from_tx_digest) {
          return;
        }

        // Pin the inbound tx to this row BEFORE doing any on-chain work. If we
        // crash mid-sweep, this row is still un-resweepable from the same
        // inbound tx (UNIQUE on claimed_from_tx_digest). On a Sui failure
        // below we throw — the txn rolls back — but on a Postgres-side commit
        // we have the digest persisted for forensics.
        await tx.pendingDeposit.update({
          where: { id: fresh.id },
          data: { claimed_from_tx_digest: transfer.txDigest },
        });

        // Load the profile to get balance_manager_id + deposit_cap_id.
        const profile = await tx.traderProfile.findUnique({
          where: { id: fresh.trader_profile_id },
        });
        if (!profile?.balance_manager_id || !profile.deposit_cap_id) {
          await tx.pendingDeposit.update({
            where: { id: fresh.id },
            data: {
              status: 'failed',
              last_error: 'profile missing balance_manager_id or deposit_cap_id',
            },
          });
          return;
        }

        // Defense in depth: re-verify the recorded sender matches the on-chain
        // sender. If someone modified the row out of band, refuse to credit.
        if (
          !profile.sui_address ||
          fresh.expected_sender_address !== transfer.senderAddress
        ) {
          await tx.pendingDeposit.update({
            where: { id: fresh.id },
            data: {
              status: 'failed',
              last_error: 'sender mismatch at claim time',
            },
          });
          return;
        }

        // Build + sign + submit. INSIDE the txn so a Sui failure rolls back
        // the row update; the advisory lock holds across the network call.
        const depositTx = buildDepositTx(
          profile.balance_manager_id,
          profile.deposit_cap_id,
          fresh.amount_mist,
          SUI_TYPE,
        );
        depositTx.setSender(executor.toSuiAddress());
        depositTx.setGasBudget(30_000_000);

        const result = (await suiGrpc.signAndExecuteTransaction({
          signer: executor,
          transaction: depositTx,
        })) as {
          Transaction?: {
            digest?: string;
            status?: { success?: boolean; error?: string | null };
          };
        };
        const inner = result.Transaction ?? {};
        if (inner.status?.success === false) {
          throw new Error(inner.status.error ?? 'deposit tx failed');
        }
        if (!inner.digest) {
          throw new Error('deposit tx returned no digest');
        }

        await tx.pendingDeposit.update({
          where: { id: fresh.id },
          data: { status: 'swept', swept_tx_digest: inner.digest },
        });
        claimState.digest = inner.digest;
        claimState.didClaim = true;
      });
    } catch (e) {
      claimError = (e as Error).message ?? String(e);
      console.error(
        `[autoDeposit] claim failed for intent ${intent.id}:`,
        claimError,
      );
      // Persist failure outside the (rolled-back) txn so we don't endlessly
      // retry a known-bad intent. We also clear claimed_from_tx_digest so the
      // unique constraint doesn't pin the digest to a row that never used it.
      try {
        await prismaQuery.pendingDeposit.update({
          where: { id: intent.id },
          data: {
            status: 'failed',
            last_error: claimError.slice(0, 1000),
            claimed_from_tx_digest: null,
          },
        });
      } catch (markErr) {
        console.error(
          `[autoDeposit] failed to mark intent ${intent.id} failed:`,
          (markErr as Error).message,
        );
      }
    }

    if (claimState.didClaim && claimState.digest) {
      const digest = claimState.digest;
      claimedTotalForGasCheck += intent.amount_mist;
      claimsThisTick++;
      lastSweepedCount += 1;
      lastSweepedAmountMist += intent.amount_mist;
      console.log(
        `[autoDeposit] swept ${intent.amount_mist} MIST from ${transfer.senderAddress} ` +
          `for ${intent.trader_profile_id} (tx ${digest.slice(0, 12)}…)`,
      );

      // Notify (best-effort). Look up the user's sui_address for dispatch.
      try {
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { id: intent.trader_profile_id },
          select: { sui_address: true },
        });
        if (profile?.sui_address) {
          await dispatch({
            userAddress: profile.sui_address,
            category: 'deposit_swept',
            text:
              `Deposited ${(Number(intent.amount_mist) / 1e9).toFixed(4)} SUI into your trading account.\n` +
              `Tx: ${digest}`,
          });
        }
      } catch (notifyErr) {
        console.warn(
          '[autoDeposit] notification dispatch failed (non-fatal):',
          (notifyErr as Error).message,
        );
      }
    }
  }
}

const tick = async (): Promise<void> => {
  if (isRunning) {
    // Previous tick still going; skip — avoids stacked work on a slow RPC.
    return;
  }
  isRunning = true;
  // Reset per-tick counters so status reflects the most recent tick only.
  lastSweepedCount = 0;
  lastSweepedAmountMist = 0n;
  const startedAt = Date.now();
  try {
    await expireStaleIntents();
    await processOneSweep();
    lastTickOk = true;
  } catch (e) {
    lastTickOk = false;
    console.error('[autoDeposit] tick failed:', (e as Error).message);
  } finally {
    lastRunAtMs = Date.now();
    lastRunDurationMs = lastRunAtMs - startedAt;
    isRunning = false;
  }
};

export const startAutoDepositSweeper = (): void => {
  if (cronTask) {
    console.warn('[autoDeposit] already started');
    return;
  }
  console.log(
    `[autoDeposit] scheduled (every ${SWEEP_INTERVAL_MS / 1000}s, ` +
      `gas reserve ${SUI_GAS_RESERVE_MIST} MIST)`,
  );
  cronTask = cron.schedule(SWEEP_CRON, tick);
  // Run once on startup so we don't wait for the first cron tick.
  void tick();
};

export const stopAutoDepositSweeper = (): void => {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
};

/// Returns true while a sweep tick is running. Use for health checks.
export const isAutoDepositSweeperRunning = (): boolean => isRunning;

export interface AutoDepositSweeperStatus {
  name: 'autoDepositSweeper';
  last_run_at_ms: number | null;
  last_run_duration_ms: number | null;
  ok: boolean;
  rate_limited_until_ms: number | null;
  extra: {
    last_sweep_claim_count: number;
    last_sweep_amount_mist: string;
    is_running: boolean;
  };
}

export const getAutoDepositSweeperStatus = (): AutoDepositSweeperStatus => ({
  name: 'autoDepositSweeper',
  last_run_at_ms: lastRunAtMs,
  last_run_duration_ms: lastRunDurationMs,
  ok: lastTickOk,
  rate_limited_until_ms: rateLimitedUntilMs,
  extra: {
    last_sweep_claim_count: lastSweepedCount,
    last_sweep_amount_mist: lastSweepedAmountMist.toString(),
    is_running: isRunning,
  },
});
