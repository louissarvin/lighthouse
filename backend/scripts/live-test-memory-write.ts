/**
 * scripts/live-test-memory-write.ts
 *
 * Live-executes buildMemoryWriteWithProofTx against testnet using the
 * active sui CLI keypair. Verifies the composite PTB works end-to-end on
 * the deployed contract.
 *
 * Cost: ~0.005 SUI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextEncoder } from 'node:util';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { fromBase64 } from '@mysten/sui/utils';

import { buildMemoryWriteWithProofTx } from '../src/lib/lighthouseTxs.ts';
import { suiGrpc } from '../src/lib/sui.ts';

type AnySigner = Ed25519Keypair | Secp256k1Keypair;

const DEV_PROFILE = '0x99955a10ef8ad1c4bae44521d2c38c07d6df77c88a3ddb2bb41c9c42515e2a8e';

function loadActiveKeypair(): { keypair: AnySigner; address: string } {
  const configPath = path.join(os.homedir(), '.sui', 'sui_config', 'client.yaml');
  const activeAddr = fs
    .readFileSync(configPath, 'utf8')
    .match(/active_address:\s*"?(0x[a-f0-9]+)"?/)?.[1];
  if (!activeAddr) throw new Error('no active_address in client.yaml');

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
  throw new Error('active keypair not found in keystore');
}

async function main(): Promise<void> {
  const { keypair, address } = loadActiveKeypair();
  console.log(`signer: ${address}`);

  const client = suiGrpc;

  // Construct a non-trivial blob id (in production this comes from Walrus).
  const blobBytes = new TextEncoder().encode(
    `composite-ptb-test-${Date.now().toString(36)}`,
  );
  const tx = buildMemoryWriteWithProofTx({
    profileObjectId: DEV_PROFILE,
    slice: 'risk-profile',
    blobIdBytes: blobBytes,
    kind: 0,
  });
  tx.setSender(address);
  tx.setGasBudget(100_000_000);

  console.log('executing buildMemoryWriteWithProofTx...');
  const result = (await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  })) as {
    Transaction?: {
      digest?: string;
      status?: { success?: boolean; error?: string | null };
    };
  };
  const inner = result.Transaction ?? {};
  console.log(`digest: ${inner.digest}`);
  console.log(`success: ${inner.status?.success}`);
  if (inner.status?.error) console.log(`error: ${inner.status.error}`);
  console.log(`explorer: https://suiscan.xyz/testnet/tx/${inner.digest}`);
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
