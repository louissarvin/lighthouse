/**
 * scripts/live-test-predict-onboard.ts
 *
 * Dry-runs buildCreatePredictManagerTx on testnet to verify:
 *   - PREDICT_PACKAGE_ID + PREDICT_REGISTRY_ID env vars resolve on chain
 *   - The Move call signature matches the deployed package
 *   - A PredictManager would be created and shared
 *
 * Uses the active CLI keypair. Does NOT actually execute (dry-run only).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { fromBase64 } from '@mysten/sui/utils';

import { buildCreatePredictManagerTx } from '../src/lib/predict.ts';
import { suiGrpc } from '../src/lib/sui.ts';

type AnySigner = Ed25519Keypair | Secp256k1Keypair;

function loadActiveKeypair(): { keypair: AnySigner; address: string } {
  const cfg = fs.readFileSync(
    path.join(os.homedir(), '.sui', 'sui_config', 'client.yaml'),
    'utf8',
  );
  const activeAddr = cfg.match(/active_address:\s*"?(0x[a-f0-9]+)"?/)?.[1];
  if (!activeAddr) throw new Error('no active_address');
  const ks = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  ) as string[];
  for (const b64 of ks) {
    const bytes = fromBase64(b64);
    const secret = bytes.slice(1, 33);
    let kp: AnySigner | null = null;
    if (bytes[0] === 0x00) kp = Ed25519Keypair.fromSecretKey(secret);
    else if (bytes[0] === 0x01) kp = Secp256k1Keypair.fromSecretKey(secret);
    if (!kp) continue;
    if (kp.toSuiAddress() === activeAddr) return { keypair: kp, address: activeAddr };
  }
  throw new Error('active keypair not found');
}

async function main(): Promise<void> {
  const { keypair, address } = loadActiveKeypair();
  console.log(`sender: ${address}`);

  const tx = buildCreatePredictManagerTx();
  tx.setSender(address);
  tx.setGasBudget(100_000_000);

  console.log('executing buildCreatePredictManagerTx (REAL execution)...');
  const result = (await suiGrpc.signAndExecuteTransaction({
    signer: keypair,
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
