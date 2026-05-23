/**
 * Lighthouse Move PTB builders (sponsored via Enoki).
 *
 * These are user-signed transactions (the user is profile.owner or
 * agent.owner_address), but the gas + execution are sponsored via Enoki's
 * sponsor branch (`allowedMoveCallTargets` whitelist already includes all
 * of these in `lib/enoki.ts`).
 *
 * Signatures verified against `lighthouse_contract/sources/*.move` directly.
 * Each builder appends a single `version: &Version` first arg as required by
 * `version::check_is_valid` (see `version.move`).
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import {
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../config/main-config.ts';

function assertPackagePublished(): void {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[lighthouseTxs] LIGHTHOUSE_PACKAGE_ID is not set');
  }
  if (!LIGHTHOUSE_VERSION_OBJECT_ID) {
    throw new Error('[lighthouseTxs] LIGHTHOUSE_VERSION_OBJECT_ID is not set');
  }
}

// ============================================================================
// executor::revoke
// ============================================================================
//
//   public fun revoke(
//     version: &Version,
//     agent: &mut ExecutorAgent,
//     bm: &mut BalanceManager,
//     clock: &Clock,
//     ctx: &TxContext,
//   )
//
// Signed by the agent's `owner_address` (i.e. the user). Idempotent on chain.

export interface RevokeAgentArgs {
  executorAgentId: string;
  balanceManagerId: string;
}

export function buildRevokeAgentTx(args: RevokeAgentArgs): Transaction {
  assertPackagePublished();
  const tx = new Transaction();
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::revoke`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.executorAgentId),
      tx.object(args.balanceManagerId),
      tx.object('0x6'), // sui::clock::Clock
    ],
  });
  return tx;
}

// ============================================================================
// trader_profile::grant_audit
// ============================================================================
//
//   public fun grant_audit(
//     version: &Version,
//     profile: &mut TraderProfile,
//     auditor: address,
//     valid_until_ms: u64,
//     ctx: &mut TxContext,
//   )
//
// Mints an AuditCap to `auditor` and registers it in `profile.audit_grants`.
// Signed by `profile.owner`.

export interface GrantAuditArgs {
  profileObjectId: string;
  auditorAddress: string;
  validUntilMs: bigint;
}

export function buildGrantAuditTx(args: GrantAuditArgs): Transaction {
  assertPackagePublished();
  const tx = new Transaction();
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::grant_audit`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.profileObjectId),
      tx.pure(bcs.Address.serialize(args.auditorAddress).toBytes()),
      tx.pure(bcs.U64.serialize(args.validUntilMs).toBytes()),
    ],
  });
  return tx;
}

// ============================================================================
// trader_profile::revoke_audit
// ============================================================================
//
//   public fun revoke_audit(
//     version: &Version,
//     profile: &mut TraderProfile,
//     cap_id: ID,
//     ctx: &TxContext,
//   )
//
// Removes the AuditCap object ID from `profile.audit_grants`. The cap object
// itself remains in the auditor's wallet but no longer validates against the
// profile. Idempotent. Signed by `profile.owner`.

export interface RevokeAuditArgs {
  profileObjectId: string;
  /// AuditCap object ID — `ID` is BCS-encoded as a 32-byte address.
  capId: string;
}

export function buildRevokeAuditTx(args: RevokeAuditArgs): Transaction {
  assertPackagePublished();
  const tx = new Transaction();
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::revoke_audit`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.profileObjectId),
      // sui::object::ID is `{ id: address }` so its BCS encoding == bcs.Address.
      tx.pure(bcs.Address.serialize(args.capId).toBytes()),
    ],
  });
  return tx;
}

// ============================================================================
// trader_profile::update_blob
// ============================================================================
//
//   public fun update_blob(
//     version: &Version,
//     profile: &mut TraderProfile,
//     slice: String,
//     blob_id: vector<u8>,
//     ctx: &TxContext,
//   )
//
// Updates the cached Walrus blob ID for a slice name in `profile.latest_blobs`.
// Signed by `profile.owner`. The OFF-CHAIN authoritative source for the latest
// blob per slice is the `audit_anchor::AnchorRecorded` event stream — this
// cache exists for fast lookup without indexer.

export interface UpdateBlobArgs {
  profileObjectId: string;
  /// Slice tag (e.g. "trades", "risk-profile", "pnl:summary").
  slice: string;
  /// Walrus blob ID bytes (typically the 32-byte u256 form via blobIdToInt).
  blobIdBytes: Uint8Array;
}

export function buildUpdateBlobTx(args: UpdateBlobArgs): Transaction {
  assertPackagePublished();
  const tx = new Transaction();
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::update_blob`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.profileObjectId),
      tx.pure(bcs.String.serialize(args.slice).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(args.blobIdBytes)).toBytes()),
    ],
  });
  return tx;
}

// ============================================================================
// COMPOSITE BUILDERS — maximize PTB usage by collapsing multi-step logical
// operations into single atomic transactions. Each builder below documents
// the call sequence and the on-chain guarantees the atomicity provides.
// ============================================================================

const ZERO_DIGEST_BYTES = new Uint8Array(32);

function appendAuditAnchor(
  tx: Transaction,
  kind: number,
  walrusBlobIdBytes: Uint8Array,
  recipient: string | null,
): void {
  if (walrusBlobIdBytes.length === 0) {
    throw new Error('[lighthouseTxs] walrusBlobIdBytes must be non-empty');
  }
  const [anchor] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.pure(bcs.U8.serialize(kind).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(walrusBlobIdBytes)).toBytes()),
      // Empty 32-byte digest. AnchorRecorded event's enclosing transaction IS
      // the anchored event by definition; off-chain joins via Sui RPC.
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(ZERO_DIGEST_BYTES)).toBytes()),
      tx.object('0x6'),
    ],
  });
  // Anchor has key+store; we MUST transfer. `transfer_to_owner` reads
  // `anchor.owner` which is `ctx.sender()` from the record call.
  void recipient; // recipient defaults to sender via transfer_to_owner
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
    arguments: [anchor],
  });
}

// ─── 1. Memory write with proof (per coaching session) ─────────────────────
//
// The most common backend write. EVERY blob the Coach writes to Walrus must
// (a) be reflected in the on-chain TraderProfile cache and (b) leave an
// audit-anchor event. Doing them atomically guarantees that no off-chain
// blob exists without its provable on-chain reference, and vice versa.
//
// Sequence:
//   1. trader_profile::update_blob(version, profile, slice, blob)
//   2. audit_anchor::record(version, kind, blob, empty_digest, clock) → anchor
//   3. audit_anchor::transfer_to_owner(anchor)

export interface MemoryWriteWithProofArgs {
  profileObjectId: string;
  slice: string;
  blobIdBytes: Uint8Array;
  /// Anchor kind: 0=recommendation, 1=trade, 2=weekly_report.
  /// Most memory writes are 0 (recommendation). The Settlement Keeper uses 2.
  kind?: number;
}

export function buildMemoryWriteWithProofTx(args: MemoryWriteWithProofArgs): Transaction {
  assertPackagePublished();
  if (args.blobIdBytes.length === 0) {
    throw new Error('[lighthouseTxs] blobIdBytes must be non-empty');
  }
  const tx = new Transaction();

  // 1. Update the blob cache.
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::update_blob`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.profileObjectId),
      tx.pure(bcs.String.serialize(args.slice).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(args.blobIdBytes)).toBytes()),
    ],
  });

  // 2 + 3. Audit anchor in the same atomic tx.
  appendAuditAnchor(tx, args.kind ?? 0, args.blobIdBytes, null);

  return tx;
}

// ─── 2. Weekly settlement batch (one PTB, many users) ─────────────────────
//
// The Settlement Keeper runs weekly. Instead of submitting N separate audit
// anchors for N users (N * compute_cost + N * storage_cost), this builder
// packs them all in one PTB. Sui charges one transaction-base fee + per-call
// storage, so batching saves the per-tx fixed cost.
//
// Each entry produces a fresh AuditAnchor transferred to the Settlement
// Keeper signer (NOT to the per-user owner — Settlement Keeper holds the
// archive). If you want per-user delivery, use buildMemoryWriteWithProofTx
// in a loop instead.
//
// Sequence (per entry):
//   1. audit_anchor::record(version, 2, blob_i, empty_digest, clock) → anchor_i
//   2. audit_anchor::transfer_to_owner(anchor_i)

export interface WeeklyAuditBatchEntry {
  /// Walrus blob ID for this user's weekly tearsheet.
  walrusBlobIdBytes: Uint8Array;
}

export function buildWeeklyAuditBatchTx(entries: WeeklyAuditBatchEntry[]): Transaction {
  assertPackagePublished();
  if (entries.length === 0) {
    throw new Error('[lighthouseTxs] weekly batch needs at least 1 entry');
  }
  // Sui PTB hard limit: 1024 commands per block. Each entry = 2 commands
  // (record + transfer). Cap below the limit to leave room for gas estimation.
  if (entries.length > 400) {
    throw new Error(
      `[lighthouseTxs] weekly batch entries (${entries.length}) exceeds 400; chunk into smaller PTBs`,
    );
  }
  const tx = new Transaction();
  for (const entry of entries) {
    appendAuditAnchor(tx, 2 /* weekly_report */, entry.walrusBlobIdBytes, null);
  }
  return tx;
}

// ─── 3. Revoke agent with audit proof ─────────────────────────────────────
//
// When a user revokes their ExecutorAgent (kill switch), we want an audit
// anchor of the revocation event for post-mortem analysis. Atomically
// composing means the revoke and the audit cannot be separated.
//
// Sequence:
//   1. executor::revoke(version, agent, bm, clock)
//   2. audit_anchor::record(version, 0, revocation_blob, empty_digest, clock) → anchor
//   3. audit_anchor::transfer_to_owner(anchor)
//
// `revocationBlobIdBytes` should point to a Walrus blob containing the
// off-chain context (reason, timestamp, user note). If you don't have
// supplemental context, set this to a 32-byte hash of the agent ID so the
// anchor still carries verifiable provenance.

export interface RevokeAgentWithProofArgs {
  executorAgentId: string;
  balanceManagerId: string;
  /// Walrus blob ID for the revocation rationale. Non-empty.
  revocationBlobIdBytes: Uint8Array;
}

export function buildRevokeAgentWithProofTx(args: RevokeAgentWithProofArgs): Transaction {
  assertPackagePublished();
  if (args.revocationBlobIdBytes.length === 0) {
    throw new Error('[lighthouseTxs] revocationBlobIdBytes must be non-empty');
  }
  const tx = new Transaction();

  // 1. Revoke. This is idempotent on-chain so re-submission is safe.
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::revoke`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.executorAgentId),
      tx.object(args.balanceManagerId),
      tx.object('0x6'),
    ],
  });

  // 2 + 3. Audit anchor for the revocation event (kind=0 recommendation).
  appendAuditAnchor(tx, 0, args.revocationBlobIdBytes, null);

  return tx;
}

// ─── 4. Onboarding completion proof ────────────────────────────────────────
//
// Append-only helper for the route that finalizes onboarding. After the
// §10.4 mega-PTB (buildOnboardingTx in deepbook.ts) creates BM + Profile,
// the Coach generates the initial risk profile blob and we want to:
//   (a) write it to the brand-new TraderProfile via update_blob
//   (b) emit an audit anchor declaring "onboarding completed at <blob>"
// in a single follow-up PTB. This separation is intentional because the
// §10.4 PTB cannot reference the Profile ID it just created without a
// dynamic ObjectChange lookup that happens off-chain.
//
// Sequence: identical to buildMemoryWriteWithProofTx but with slice fixed
// to "risk-profile" and kind=0 (recommendation = initial risk profile).

export function buildOnboardingCompletionTx(args: {
  profileObjectId: string;
  initialRiskProfileBlobBytes: Uint8Array;
}): Transaction {
  return buildMemoryWriteWithProofTx({
    profileObjectId: args.profileObjectId,
    slice: 'risk-profile',
    blobIdBytes: args.initialRiskProfileBlobBytes,
    kind: 0,
  });
}

// ─── 5. Standalone audit anchor (no user-owned object touched) ────────────
//
// The simplest, most flexible builder: 2-call PTB that just emits an
// AuditAnchor and transfers it to the sender. Useful for backend-owned
// audit anchors that the Coach keypair records on behalf of the user
// (no ownership gate on audit_anchor::record).
//
// Sequence:
//   1. audit_anchor::record(version, kind, blob, empty_digest, clock) → anchor
//   2. audit_anchor::transfer_to_owner(anchor)

export function buildAuditAnchorTx(args: {
  walrusBlobIdBytes: Uint8Array;
  /// 0=recommendation, 1=trade, 2=weekly_report.
  kind: number;
}): Transaction {
  assertPackagePublished();
  const tx = new Transaction();
  appendAuditAnchor(tx, args.kind, args.walrusBlobIdBytes, null);
  return tx;
}
