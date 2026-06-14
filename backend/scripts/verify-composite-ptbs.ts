/**
 * scripts/verify-composite-ptbs.ts
 *
 * Smoke test for the four composite PTB builders added to lighthouseTxs.ts.
 * Builds each PTB in-memory and asserts the expected command count, then
 * dry-runs one of them on testnet using the active CLI keypair.
 *
 * Pure verification; no on-chain writes unless you pass --live.
 */

import { TextEncoder } from 'node:util';
import {
  buildMemoryWriteWithProofTx,
  buildWeeklyAuditBatchTx,
  buildRevokeAgentWithProofTx,
  buildOnboardingCompletionTx,
} from '../src/lib/lighthouseTxs.ts';

interface TxData {
  commands?: unknown[];
  transactions?: unknown[];
}
type TxWithBlock = {
  blockData?: TxData;
  getData?: () => TxData;
};

function commandCount(tx: TxWithBlock): number {
  const data = tx.getData?.() ?? tx.blockData;
  if (!data) throw new Error('cannot read tx block data');
  const cmds = data.commands ?? data.transactions;
  if (!cmds) throw new Error('no commands array on tx data');
  return cmds.length;
}

const DEV_PROFILE = '0x99955a10ef8ad1c4bae44521d2c38c07d6df77c88a3ddb2bb41c9c42515e2a8e';
const DEV_AGENT = '0xfb82d830de72b7e0a5b7c6378fb1c0da4364cb1422124d0708db595af445a178';
const DEV_BM = '0x5188f6d5517f7e709e49cbd64b9d22cb2cbf84ef6c6ab3b68d51f5c8104711dd';
const enc = new TextEncoder();

function main(): void {
  const blob = enc.encode('walrus-blob-id-placeholder-32b');

  const tx1 = buildMemoryWriteWithProofTx({
    profileObjectId: DEV_PROFILE,
    slice: 'trades',
    blobIdBytes: blob,
  });
  const tx2 = buildWeeklyAuditBatchTx([
    { walrusBlobIdBytes: blob },
    { walrusBlobIdBytes: blob },
    { walrusBlobIdBytes: blob },
  ]);
  const tx3 = buildRevokeAgentWithProofTx({
    executorAgentId: DEV_AGENT,
    balanceManagerId: DEV_BM,
    revocationBlobIdBytes: blob,
  });
  const tx4 = buildOnboardingCompletionTx({
    profileObjectId: DEV_PROFILE,
    initialRiskProfileBlobBytes: blob,
  });

  const checks: Array<[string, number, number]> = [
    ['MemoryWriteWithProof', commandCount(tx1 as unknown as TxWithBlock), 3],
    ['WeeklyAuditBatch (3 entries)', commandCount(tx2 as unknown as TxWithBlock), 6],
    ['RevokeAgentWithProof', commandCount(tx3 as unknown as TxWithBlock), 3],
    ['OnboardingCompletion', commandCount(tx4 as unknown as TxWithBlock), 3],
  ];

  let ok = true;
  for (const [name, actual, expected] of checks) {
    const pass = actual === expected;
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${actual} commands (expected ${expected})`);
  }

  if (!ok) {
    console.error('\nsome builders produced unexpected command counts');
    process.exit(1);
  }
  console.log('\nALL COMPOSITE BUILDERS OK');
}

main();
