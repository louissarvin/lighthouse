/**
 * scripts/verify-predict-builders.ts
 *
 * Shape-verifies the 4 Predict PTB builders. Each builder produces a
 * Transaction object; we assert the right number of moveCalls compose
 * into each one.
 *
 * No on-chain writes. Pure local verification.
 */

import { TextEncoder } from 'node:util';
import {
  buildCreatePredictManagerTx,
  buildPredictDepositTx,
  buildPredictMintTx,
  buildPredictRedeemTx,
} from '../src/lib/predict.ts';

interface TxData {
  commands?: unknown[];
}
type TxWithGetData = { getData?: () => TxData };

function commandCount(tx: TxWithGetData): number {
  const data = tx.getData?.();
  if (!data?.commands) throw new Error('cannot read commands');
  return data.commands.length;
}

const PREDICT_TESTNET = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const DUMMY_MANAGER = '0x' + '11'.repeat(32);
const DUMMY_ORACLE = '0x' + '22'.repeat(32);
const DUMMY_COIN = '0x' + '33'.repeat(32);
const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';

function main(): void {
  const blob = new TextEncoder().encode('predict-rationale-blob');

  const tx1 = buildCreatePredictManagerTx();
  const tx2 = buildPredictDepositTx({
    managerObjectId: DUMMY_MANAGER,
    coinObjectId: DUMMY_COIN,
    coinTypeTag: DUSDC,
  });
  // Without audit: 2 calls (market_key::new + predict::mint)
  const tx3a = buildPredictMintTx({
    predictObjectId: PREDICT_TESTNET,
    managerObjectId: DUMMY_MANAGER,
    oracleObjectId: DUMMY_ORACLE,
    quoteTypeTag: DUSDC,
    oracleId: DUMMY_ORACLE,
    expiryMs: 1781800000000n,
    strike: 250_000_000n,
    isUp: true,
    quantity: 1_000_000n,
  });
  // With audit: 4 calls (market_key::new + predict::mint + record + transfer)
  const tx3b = buildPredictMintTx({
    predictObjectId: PREDICT_TESTNET,
    managerObjectId: DUMMY_MANAGER,
    oracleObjectId: DUMMY_ORACLE,
    quoteTypeTag: DUSDC,
    oracleId: DUMMY_ORACLE,
    expiryMs: 1781800000000n,
    strike: 250_000_000n,
    isUp: true,
    quantity: 1_000_000n,
    auditWalrusBlobIdBytes: blob,
  });
  const tx4 = buildPredictRedeemTx({
    predictObjectId: PREDICT_TESTNET,
    managerObjectId: DUMMY_MANAGER,
    oracleObjectId: DUMMY_ORACLE,
    quoteTypeTag: DUSDC,
    oracleId: DUMMY_ORACLE,
    expiryMs: 1781800000000n,
    strike: 250_000_000n,
    isUp: true,
    quantity: 1_000_000n,
    auditWalrusBlobIdBytes: blob,
  });

  const checks: Array<[string, number, number]> = [
    ['CreatePredictManager', commandCount(tx1 as unknown as TxWithGetData), 1],
    ['PredictDeposit', commandCount(tx2 as unknown as TxWithGetData), 1],
    ['PredictMint (no audit)', commandCount(tx3a as unknown as TxWithGetData), 2],
    ['PredictMint (with audit)', commandCount(tx3b as unknown as TxWithGetData), 4],
    ['PredictRedeem (with audit)', commandCount(tx4 as unknown as TxWithGetData), 4],
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
  console.log('\nALL PREDICT BUILDERS OK');
}

main();
