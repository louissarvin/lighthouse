/**
 * Coach-side audit anchor recorder.
 *
 * Uploads a snippet of text to Walrus, then writes an on-chain `AuditAnchor`
 * with kind=0 (recommendation) referencing the blob. Both steps are signed
 * by the Coach Agent keypair, NOT by the end user — `audit_anchor::record`
 * has no sender check, so the resulting on-chain artifact carries the
 * Coach's signature and the user's `TraderProfile` is NEVER mutated.
 *
 * This is the canonical "show on-chain proof in chat" primitive:
 *   - Telegram bot's "💾 Save & Anchor" inline button
 *   - Backend tearsheet generator
 *   - Any place we want a publicly-verifiable receipt without asking the
 *     user to sign anything
 *
 * For user-gated writes (`trader_profile::update_blob`,
 * `executor::place_limit_under_budget`, `trader_profile::grant_*`), use
 * `buildMemoryWriteWithProofTx` etc. from `lighthouseTxs.ts` and route
 * through Enoki sponsorship + the user's wallet.
 */

import { writeBlob, blobUrl as walrusBlobUrl } from './walrus.ts';
import { getCoachKeypair } from './keypairs.ts';
import { suiGrpc } from './sui.ts';
import { buildAuditAnchorTx } from './lighthouseTxs.ts';

const ANCHOR_GAS_BUDGET = 50_000_000;

export interface AnchorResult {
  /// The Sui transaction digest carrying the on-chain `AnchorRecorded` event.
  digest: string;
  /// Walrus blob ID (base64url). Resolvable via the aggregator URL.
  blobId: string;
  /// Public URL for the blob on the testnet aggregator.
  blobUrl: string;
  /// Public testnet explorer URL for the tx.
  explorerUrl: string;
}

/**
 * Upload `bytes` to Walrus + emit an `AuditAnchor(kind)` PTB signed by Coach.
 *
 * @param bytes Anything you want anchored. Plain text, JSON, encrypted blob.
 *              The Coach does NOT encrypt here — caller is responsible for
 *              SEAL or any privacy layer.
 * @param kind  0 = recommendation, 1 = trade, 2 = weekly_report
 */
export async function anchorBlob(
  bytes: Uint8Array,
  kind = 0,
): Promise<AnchorResult> {
  if (bytes.length === 0) throw new Error('[coachAnchor] bytes is empty');
  if (kind < 0 || kind > 2) throw new Error(`[coachAnchor] invalid kind ${kind}`);

  const coach = getCoachKeypair();

  // 1. Upload the blob to Walrus, signed by Coach.
  const { blobId } = await writeBlob(bytes, coach, { deletable: false });

  // 2. Build + execute the audit anchor PTB. We pass the blob ID as a
  //    UTF-8 byte sequence — the contract only enforces non-empty length.
  //    Indexers can decode back to base64url for resolution.
  const blobBytes = new TextEncoder().encode(blobId);
  const tx = buildAuditAnchorTx({ walrusBlobIdBytes: blobBytes, kind });
  tx.setSender(coach.toSuiAddress());
  tx.setGasBudget(ANCHOR_GAS_BUDGET);

  const result = (await suiGrpc.signAndExecuteTransaction({
    signer: coach,
    transaction: tx,
  })) as {
    Transaction?: {
      digest?: string;
      status?: { success?: boolean; error?: string | null };
    };
  };
  const inner = result.Transaction ?? {};
  if (!inner.digest) {
    throw new Error('[coachAnchor] tx returned no digest');
  }
  if (inner.status && inner.status.success === false) {
    throw new Error(`[coachAnchor] tx failed: ${inner.status.error ?? 'unknown'}`);
  }

  return {
    digest: inner.digest,
    blobId,
    blobUrl: walrusBlobUrl(blobId),
    explorerUrl: `https://suiscan.xyz/testnet/tx/${inner.digest}`,
  };
}

/**
 * Convenience wrapper for the most common case: take a UTF-8 string,
 * anchor it as kind=0 (recommendation).
 */
export async function anchorText(text: string): Promise<AnchorResult> {
  return anchorBlob(new TextEncoder().encode(text), 0);
}
