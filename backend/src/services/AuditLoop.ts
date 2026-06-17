/**
 * AuditLoop — the SEAL + Walrus + audit_anchor sequence after a trade or
 * recommendation finalises.
 *
 * Sequence (LIGHTHOUSE.md §4.4 step 10-11, researcher Q4 Option A):
 *   1. Build SEAL identity: `[profile_id_32_bytes][':'][slice_utf8]`
 *   2. Encrypt with SealClient. NO `aad` (researcher Q4: identity binding is
 *      sufficient; using blob_id as AAD creates a chicken-and-egg ordering).
 *   3. Write the ciphertext to Walrus → returns base64url blob ID string.
 *   4. Decode blob ID to its canonical 32-byte u256 form.
 *   5. Build a PTB calling `audit_anchor::record` and either:
 *      (a) sponsor via Enoki (user signs) — for trades the user initiated.
 *      (b) backend signs with the coach keypair — for system events.
 *   6. Memwal `rememberAndWait` referencing the blob ID for cross-session recall.
 *
 * The backend-signed path is preferred for v1 simplicity. User-signed path
 * (Enoki sponsor) is for trade-confirmation flows where the user is online.
 *
 * Source: `@mysten/walrus@1.1.7` `utils/bcs.mjs` (blobIdToInt), researcher Q4.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { blobIdToInt } from '@mysten/walrus';

import {
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../config/main-config.ts';
import { getCoachKeypair } from '../lib/keypairs.ts';
import { sealEncrypt } from '../lib/seal.ts';
import { suiGrpc } from '../lib/sui.ts';
import { writeBlob } from '../lib/walrus.ts';
import { rememberAndWait, type RecallEntry } from '../lib/memwal.ts';

// === SEAL identity construction ===

/// Build the SEAL inner-id hex string for a profile + slice.
/// Layout matches `trader_profile.move:18-20`:
///   [0..32]   = profile object id bytes
///   [32]      = ':' byte (0x3a)
///   [33..N]   = slice utf-8
export function buildSealIdentity(profileObjectId: string, slice: string): string {
  const hex = profileObjectId.startsWith('0x') ? profileObjectId.slice(2) : profileObjectId;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[auditLoop] profileObjectId must be 32 bytes hex, got "${profileObjectId}"`);
  }
  const sliceHex = Buffer.from(slice, 'utf8').toString('hex');
  return hex + '3a' + sliceHex;
}

// === Audit anchor kinds (match audit_anchor.move) ===

export const KIND_RECOMMENDATION = 0;
export const KIND_TRADE = 1;
export const KIND_WEEKLY_REPORT = 2;

// === Main public API ===

export interface ArchiveBlobArgs {
  profileObjectId: string;
  /// Slice tag — see LIGHTHOUSE.md §7.1 (trades / risk-profile / pnl:summary / etc.)
  slice: string;
  /// The plaintext to archive.
  plaintext: Uint8Array | string;
  /// Audit anchor kind.
  kind: 0 | 1 | 2;
  /// Walrus retention (default per config).
  epochs?: number;
  /// MemWal account + delegate for memory write (optional — omit if this slice
  /// is not a candidate for semantic recall).
  memwal?: { delegateKey: string; accountId: string; namespace?: string; rememberText?: string };
  /// Optional: tx digest of the originating trade. If omitted, we use the
  /// audit_anchor tx's own digest (chicken-and-egg: we don't have it until
  /// after the PTB executes, so we pass 32 zero bytes as a sentinel).
  originatingTxDigestBase58?: string;
}

export interface ArchiveBlobResult {
  walrusBlobId: string;
  walrusBlobBytes: Uint8Array;
  auditAnchorTxDigest: string;
  /// Convenience: if `memwal` was provided, the memwal blob id returned by
  /// `rememberAndWait`. Null otherwise.
  memwalBlobId: string | null;
}

/**
 * Encrypt → write to Walrus → record on-chain audit anchor. Optionally
 * persist a MemWal memory in parallel.
 *
 * The coach keypair signs the audit_anchor PTB; the result is owned by the
 * COACH address. The audit_anchor module's `record` does not gate by owner,
 * so this is acceptable. A later trade-confirmation flow can sponsor an
 * anchor PTB signed by the USER for stronger non-repudiation.
 */
export async function archiveBlob(args: ArchiveBlobArgs): Promise<ArchiveBlobResult> {
  if (!LIGHTHOUSE_PACKAGE_ID) throw new Error('[auditLoop] LIGHTHOUSE_PACKAGE_ID is not set');
  if (!LIGHTHOUSE_VERSION_OBJECT_ID) throw new Error('[auditLoop] LIGHTHOUSE_VERSION_OBJECT_ID is not set');

  // 1. Coerce plaintext.
  const plaintext =
    typeof args.plaintext === 'string'
      ? new TextEncoder().encode(args.plaintext)
      : args.plaintext;

  // 2. SEAL encrypt (no AAD — see researcher Q4 Option A rationale).
  const innerId = buildSealIdentity(args.profileObjectId, args.slice);
  const { encryptedObject } = await sealEncrypt(innerId, plaintext, '');

  // 3. Walrus write.
  const coach = getCoachKeypair();
  const { blobId: blobIdBase64url } = await writeBlob(encryptedObject, coach, {
    deletable: false,
    epochs: args.epochs,
  });

  // 4. Convert blob id → 32 raw bytes (u256 BCS form).
  // Source: @mysten/walrus utils/bcs.mjs `blobIdFromInt` is the encoder;
  // `blobIdToInt` is the inverse used here.
  const u256 = blobIdToInt(blobIdBase64url);
  const rawBlobBytes = bcs.u256().serialize(u256).toBytes(); // little-endian 32 bytes

  // 5. Build audit_anchor::record PTB.
  const txDigestBytes = decodeTxDigestOr32Zero(args.originatingTxDigestBase58);

  const tx = new Transaction();
  const [anchor] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.pure(bcs.U8.serialize(args.kind).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(rawBlobBytes)).toBytes()),
      tx.pure(bcs.vector(bcs.U8).serialize(Array.from(txDigestBytes)).toBytes()),
      tx.object('0x6'),
    ],
  });
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
    arguments: [anchor],
  });

  // Sign with coach keypair + execute.
  const built = await tx.build({ client: suiGrpc as never });
  const sig = await coach.signTransaction(built);
  const result = await suiGrpc.executeTransaction({
    transaction: built,
    signatures: [sig.signature],
  });
  const auditAnchorTxDigest = (result as { digest?: string }).digest ?? '';

  // 6. MemWal memory (optional).
  let memwalBlobId: string | null = null;
  if (args.memwal && args.memwal.rememberText) {
    const r = await rememberAndWait(
      { delegateKey: args.memwal.delegateKey, accountId: args.memwal.accountId },
      args.memwal.rememberText,
      args.memwal.namespace,
    );
    memwalBlobId = r.blobId;
  }

  return {
    walrusBlobId: blobIdBase64url,
    walrusBlobBytes: rawBlobBytes,
    auditAnchorTxDigest,
    memwalBlobId,
  };
}

// === Helpers ===

/**
 * Decode a Sui tx digest (base58, 32 bytes) into raw bytes. If the caller
 * didn't supply one, return 32 zero bytes (a documented sentinel — the
 * `audit_anchor::record` aborts only if length != 32, NOT if content is zero).
 */
function decodeTxDigestOr32Zero(base58?: string): Uint8Array {
  if (!base58) {
    return new Uint8Array(32);
  }
  // Sui tx digests are base58-encoded 32 bytes. Convert via @mysten/sui/utils.
  // The `fromBase58` helper lives in `@mysten/sui/utils`.
  return base58ToBytes32(base58);
}

/// Minimal in-line base58 decoder (Bitcoin alphabet). Avoids importing a
/// heavyweight base58 dep; we only need to handle 32-byte digests.
function base58ToBytes32(input: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const map = new Map(Array.from(ALPHABET, (c, i) => [c, BigInt(i)] as const));
  let result = 0n;
  for (const ch of input) {
    const v = map.get(ch);
    if (v === undefined) throw new Error(`[auditLoop] invalid base58 char: "${ch}"`);
    result = result * 58n + v;
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(result & 0xffn);
    result >>= 8n;
  }
  return out;
}

export type { RecallEntry };

/**
 * Human-readable summary of an archiveBlob result for logging/monitoring.
 * e.g. "[auditLoop] archived: blobId=abc123 anchor=Def456 memwal=Ghi789"
 */
export function archiveResultLog(result: ArchiveBlobResult): string {
  const short = (s: string) => s.slice(0, 10) + '…';
  const parts = [
    `blobId=${short(result.walrusBlobId)}`,
    `anchor=${short(result.auditAnchorTxDigest)}`,
  ];
  if (result.memwalBlobId) parts.push(`memwal=${short(result.memwalBlobId)}`);
  return `[auditLoop] archived: ${parts.join(' ')}`;
}
