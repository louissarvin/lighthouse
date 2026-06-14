/**
 * scripts/live-test-anchor-only.ts
 *
 * Live-tests the on-chain audit-anchor portion of the bot's "💾 Save & Anchor"
 * flow, WITHOUT touching Walrus. Proves that:
 *   - Coach keypair loads correctly
 *   - buildAuditAnchorTx produces a valid PTB
 *   - Coach can sign + execute against the deployed contract
 *
 * The actual coachAnchor.anchorText() also uploads to Walrus, which requires
 * the Coach address to hold testnet WAL. This script SKIPS that step so the
 * bot wiring can be verified independently.
 */

import { TextEncoder } from 'node:util';
import { buildAuditAnchorTx } from '../src/lib/lighthouseTxs.ts';
import { getCoachKeypair } from '../src/lib/keypairs.ts';
import { suiGrpc } from '../src/lib/sui.ts';

async function main(): Promise<void> {
  const coach = getCoachKeypair();
  const sender = coach.toSuiAddress();
  console.log(`coach address: ${sender}`);

  const placeholder = new TextEncoder().encode(
    `coach-anchor-placeholder-${Date.now().toString(36)}`,
  );
  const tx = buildAuditAnchorTx({
    walrusBlobIdBytes: placeholder,
    kind: 0,
  });
  tx.setSender(sender);
  tx.setGasBudget(50_000_000);

  console.log('executing anchor PTB...');
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
  console.log(`digest:  ${inner.digest}`);
  console.log(`success: ${inner.status?.success}`);
  if (inner.status?.error) console.log(`error:   ${inner.status.error}`);
  if (inner.digest) {
    console.log(`explorer: https://suiscan.xyz/testnet/tx/${inner.digest}`);
  }
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
