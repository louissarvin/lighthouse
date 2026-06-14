/**
 * scripts/deposit-to-bm.ts
 *
 * Deposits SUI (and optionally DBUSDC) into an existing BalanceManager so the
 * ExecutorAgent can place DeepBook orders on the user's behalf.
 *
 * Run once whenever the BM balance runs low. Safe to re-run — it just adds
 * more funds.
 *
 * Usage:
 *   bun run scripts/deposit-to-bm.ts
 *
 * The active Sui CLI keypair (sui.keystore / client.yaml) is used as the
 * signer, so the BM owner must be the active address.
 *
 * Pool constraints (SUI/DBUSDC testnet, queried 2026-06-19):
 *   min_size  = 1_000_000_000 (1 SUI)  ← minimum order
 *   lot_size  =   100_000_000 (0.1 SUI) ← quantity increment
 *   tick_size =            10            ← price increment
 *
 * We deposit 5 SUI by default — enough for 5 minimum-sized orders plus fees.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';

import {
  DEEPBOOK_PACKAGE_ID,
  DEV_BALANCE_MANAGER_ID,
} from '../src/config/main-config.ts';
import { suiGrpc } from '../src/lib/sui.ts';

const SUI_TYPE_TAG =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// 3 SUI — enough for multiple 1 SUI minimum-sized orders plus fees.
// Increase if you want a bigger buffer (make sure wallet has enough first).
const DEPOSIT_AMOUNT = 3_000_000_000n;

type AnySigner = Ed25519Keypair | Secp256k1Keypair;

function loadActiveKeypair(): { keypair: AnySigner; address: string } {
  const cfg = fs.readFileSync(
    path.join(os.homedir(), '.sui', 'sui_config', 'client.yaml'),
    'utf8',
  );
  const activeAddr = cfg.match(/active_address:\s*"?(0x[a-f0-9]+)"?/)?.[1];
  if (!activeAddr) throw new Error('no active_address in client.yaml');
  const ks = JSON.parse(
    fs.readFileSync(
      path.join(os.homedir(), '.sui', 'sui_config', 'sui.keystore'),
      'utf8',
    ),
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
  if (!DEEPBOOK_PACKAGE_ID) throw new Error('DEEPBOOK_PACKAGE_ID not set in .env');
  if (!DEV_BALANCE_MANAGER_ID) throw new Error('DEV_BALANCE_MANAGER_ID not set in .env');

  const { keypair, address } = loadActiveKeypair();

  console.log(`signer:           ${address}`);
  console.log(`balance_manager:  ${DEV_BALANCE_MANAGER_ID}`);
  console.log(`deposit:          ${Number(DEPOSIT_AMOUNT) / 1e9} SUI`);
  console.log('');

  const tx = new Transaction();

  // Split SUI from the gas coin and deposit into the BalanceManager.
  const [depositCoin] = tx.splitCoins(tx.gas, [DEPOSIT_AMOUNT]);
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
    typeArguments: [SUI_TYPE_TAG],
    arguments: [tx.object(DEV_BALANCE_MANAGER_ID), depositCoin],
  });

  tx.setSender(address);
  tx.setGasBudget(100_000_000);

  console.log('submitting deposit tx...');
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
  if (inner.status?.error) {
    console.error(`error:   ${inner.status.error}`);
    process.exit(1);
  }

  console.log(`\nDone. BalanceManager now has ${Number(DEPOSIT_AMOUNT) / 1e9} SUI.`);
  console.log(`Explorer: https://suiscan.xyz/testnet/tx/${inner.digest}`);
  console.log(`\nTry: /trade sell SUI 1 @4.20`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('failed:', err);
    process.exit(1);
  });
