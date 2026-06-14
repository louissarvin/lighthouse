/**
 * scripts/verify-gaps.ts
 *
 * Shape-verify the new gap implementations:
 *   - Predict supply/withdraw builders produce 2-call PTBs (moveCall + transfer)
 *   - Both new whitelist entries exist
 *   - WeeklyTearsheet refactor: buildWeeklyAuditBatchTx still produces 2N calls
 */

import {
  buildPredictSupplyTx,
  buildPredictWithdrawTx,
  getPredictAllowedMoveCallTargets,
} from '../src/lib/predict.ts';
import { buildWeeklyAuditBatchTx } from '../src/lib/lighthouseTxs.ts';

interface TxData {
  commands?: unknown[];
}
type TxWithGetData = { getData?: () => TxData };
function commandCount(tx: TxWithGetData): number {
  return tx.getData?.()?.commands?.length ?? 0;
}

const PREDICT = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
const DUMMY = '0x' + '11'.repeat(32);
const ADDR = '0xa2b8c5d575ea1330fe68967d9d67570d9b1d4007ec813c39e6fbddacdb1da872';

function main(): void {
  const tx1 = buildPredictSupplyTx({
    predictObjectId: PREDICT,
    coinObjectId: DUMMY,
    quoteTypeTag: DUSDC,
    recipient: ADDR,
  });
  const tx2 = buildPredictWithdrawTx({
    predictObjectId: PREDICT,
    lpCoinObjectId: DUMMY,
    quoteTypeTag: DUSDC,
    recipient: ADDR,
  });
  const tx3 = buildWeeklyAuditBatchTx([
    { walrusBlobIdBytes: new Uint8Array([1, 2, 3]) },
    { walrusBlobIdBytes: new Uint8Array([4, 5, 6]) },
    { walrusBlobIdBytes: new Uint8Array([7, 8, 9]) },
    { walrusBlobIdBytes: new Uint8Array([10, 11, 12]) },
    { walrusBlobIdBytes: new Uint8Array([13, 14, 15]) },
  ]);

  const targets = getPredictAllowedMoveCallTargets();

  const checks: Array<[string, boolean]> = [
    ['PredictSupply: 2 commands', commandCount(tx1 as unknown as TxWithGetData) === 2],
    ['PredictWithdraw: 2 commands', commandCount(tx2 as unknown as TxWithGetData) === 2],
    ['WeeklyAuditBatch (5 entries): 10 commands', commandCount(tx3 as unknown as TxWithGetData) === 10],
    ['Whitelist includes supply', targets.some((t) => t.endsWith('::predict::supply'))],
    ['Whitelist includes withdraw', targets.some((t) => t.endsWith('::predict::withdraw'))],
    ['Whitelist has 7 entries', targets.length === 7],
  ];

  let ok = true;
  for (const [name, pass] of checks) {
    if (!pass) ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }
  if (!ok) process.exit(1);
  console.log('\nALL GAP IMPLEMENTATIONS OK');
}

main();
