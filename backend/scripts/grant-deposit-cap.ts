/**
 * scripts/grant-deposit-cap.ts
 *
 * One-time script for existing users whose BalanceManager was created before
 * DepositCap support was added to setup-user-trading-state.ts.
 *
 * Mints a DepositCap from the BM, transfers it to the backend executor address,
 * and writes the object ID to the user's TraderProfile in Postgres.
 *
 * After this runs, /deposit in the Telegram bot will work for this user.
 *
 * Usage:
 *   bun run scripts/grant-deposit-cap.ts
 *
 * Must be run as the BM OWNER (active Sui CLI keypair = BM.owner).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';

import { SuiClient } from '@mysten/sui/client';
import {
  DEEPBOOK_PACKAGE_ID,
} from '../src/config/main-config.ts';
import { getExecutorKeypair } from '../src/lib/keypairs.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { suiGrpc } from '../src/lib/sui.ts';

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
  if (!DEEPBOOK_PACKAGE_ID) throw new Error('DEEPBOOK_PACKAGE_ID not set');

  const { keypair, address } = loadActiveKeypair();
  const executorAddr = getExecutorKeypair().toSuiAddress();

  // Look up the BM ID from the user's TraderProfile in Postgres.
  // Falls back to BM_ID env var if set (for manual override).
  let bmId = process.env.BM_ID;
  if (!bmId) {
    const profile = await prismaQuery.traderProfile.findFirst({
      where: { sui_address: address },
      select: { balance_manager_id: true, deposit_cap_id: true },
    });
    if (!profile) {
      throw new Error(
        `No TraderProfile found for active address ${address}.\n` +
        `Either:\n` +
        `  1. Switch to the correct Sui CLI address (the BM owner), OR\n` +
        `  2. Set BM_ID=0x... env var to override.`,
      );
    }
    if (!profile.balance_manager_id) {
      throw new Error('TraderProfile found but balance_manager_id is empty. Run setup first.');
    }
    if (profile.deposit_cap_id) {
      console.log(`DepositCap already granted: ${profile.deposit_cap_id}`);
      console.log('Nothing to do.');
      return;
    }
    bmId = profile.balance_manager_id;
  }

  console.log(`signer (BM owner): ${address}`);
  console.log(`balance_manager:   ${bmId}`);
  console.log(`executor (gets cap): ${executorAddr}`);
  console.log('');

  const tx = new Transaction();

  // mint_deposit_cap requires ctx.sender() == bm.owner
  const [depositCap] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::mint_deposit_cap`,
    arguments: [tx.object(bmId)],
  });

  // Transfer to backend executor so it can call deposit_with_cap later
  tx.transferObjects([depositCap], executorAddr);

  tx.setSender(address);
  tx.setGasBudget(50_000_000);

  console.log('submitting grant-deposit-cap tx...');
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
  if (!inner.digest) throw new Error('no digest returned');

  // Use the raw JSON-RPC client to get objectChanges (suiGrpc gRPC returns a
  // different structure that doesn't include objectChanges in the same format).
  console.log('waiting for finality...');
  const rpcClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
  let capId: string | null = null;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const txInfo = await rpcClient.getTransactionBlock({
        digest: inner.digest!,
        options: { showObjectChanges: true },
      });
      const changes = txInfo.objectChanges ?? [];
      for (const c of changes) {
        if (c.type === 'created' && c.objectType?.includes('::balance_manager::DepositCap')) {
          capId = c.objectId;
          break;
        }
      }
      if (capId) break;
    } catch (e) {
      if (!(e as Error).message?.includes('NOT_FOUND')) throw e;
    }
  }
  if (!capId) throw new Error('DepositCap not found in objectChanges after ~16s');

  console.log(`\nDepositCap: ${capId}`);
  console.log(`Explorer:   https://suiscan.xyz/testnet/tx/${inner.digest}`);

  // Persist to DB
  const updated = await prismaQuery.traderProfile.updateMany({
    where: { sui_address: address },
    data: { deposit_cap_id: capId },
  });
  console.log(`\nDB rows updated: ${updated.count}`);
  if (updated.count === 0) {
    console.warn('No TraderProfile found for this address. Update deposit_cap_id manually:');
    console.warn(`  deposit_cap_id = ${capObj.objectId}`);
  }

  console.log('\nDone. /deposit will now work in the Telegram bot.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('failed:', err);
    process.exit(1);
  });
