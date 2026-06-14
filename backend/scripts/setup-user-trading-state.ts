/**
 * scripts/setup-user-trading-state.ts
 *
 * One-shot setup for a user's DeepBook-trading state. Idempotent insofar as
 * re-running creates ADDITIONAL BM + Agent — caller should only run once
 * per user.
 *
 * Atomic flow (one PTB):
 *   1. balance_manager::new                         → bm
 *   2. balance_manager::deposit<SUI>(bm, split)     (0.4 SUI for trading)
 *   3. executor::create_agent(version, bm, agent_address=BACKEND_EXECUTOR,
 *      allowed_pools, max_per_trade, max_per_day, expires_at, clock)
 *                                                  → agent
 *   4. executor::share(agent)
 *   5. transfer::public_share_object<BM>(bm)
 *
 * Effects:
 *   - User owns + shares a funded BalanceManager
 *   - User owns + shares an ExecutorAgent whose agent_address is the
 *     backend's EXECUTOR_AGENT keypair, so backend can sign trades for them
 *   - Postgres TraderProfile is updated with both object IDs
 *
 * Notes:
 *   - DEEP for trading fees must be added separately. Either swap a small
 *     amount of SUI for DEEP via the DEEP/SUI pool, or accept that the
 *     first trades will use pay_with_deep=false (works on permissionless
 *     pools, may revert on whitelisted pools).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64 } from '@mysten/sui/utils';

import {
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_SUI_DBUSDC_POOL,
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../src/config/main-config.ts';
import { getExecutorKeypair } from '../src/lib/keypairs.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { suiGrpc } from '../src/lib/sui.ts';

const SUI_TYPE_TAG = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DEEP_SUI_POOL = '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f';
const WAL_SUI_POOL = '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a';

// Trading-config defaults. Conservative for demo; tighten before mainnet.
// 5 SUI — pool min_size=1 SUI, so 0.4 SUI was always below minimum. 5 SUI
// gives enough headroom for ~5 minimum-sized orders plus taker fees.
const SUI_DEPOSIT_AMOUNT = 5_000_000_000n;      // 5 SUI in MIST
const MAX_PER_TRADE_NOTIONAL = 1_000_000_000n;   // 1 SUI / 1000 DBUSDC raw units
const MAX_PER_DAY_NOTIONAL = 10_000_000_000n;    // 10 SUI / 10K DBUSDC raw units
const AGENT_LIFETIME_MS = 90n * 24n * 60n * 60n * 1000n; // 90 days

type AnySigner = Ed25519Keypair | Secp256k1Keypair;

function loadActiveKeypair(): { keypair: AnySigner; address: string } {
  const cfg = fs.readFileSync(
    path.join(os.homedir(), '.sui', 'sui_config', 'client.yaml'),
    'utf8',
  );
  const activeAddr = cfg.match(/active_address:\s*"?(0x[a-f0-9]+)"?/)?.[1];
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
  const executorAddr = getExecutorKeypair().toSuiAddress();

  console.log(`signer:        ${address}`);
  console.log(`agent_address: ${executorAddr} (backend EXECUTOR keypair)`);
  console.log(`deposit:       ${Number(SUI_DEPOSIT_AMOUNT) / 1e9} SUI`);
  console.log(`per-trade cap: ${MAX_PER_TRADE_NOTIONAL.toString()} raw quote units`);
  console.log(`per-day cap:   ${MAX_PER_DAY_NOTIONAL.toString()} raw quote units`);
  console.log('');

  if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID || !DEEPBOOK_PACKAGE_ID) {
    throw new Error('LIGHTHOUSE_PACKAGE_ID / LIGHTHOUSE_VERSION_OBJECT_ID / DEEPBOOK_PACKAGE_ID required');
  }

  const allowedPools = [DEEPBOOK_SUI_DBUSDC_POOL, DEEP_SUI_POOL, WAL_SUI_POOL];
  const expiresAtMs = BigInt(Date.now()) + AGENT_LIFETIME_MS;

  // Build the mega-PTB.
  const tx = new Transaction();

  // 1. balance_manager::new (returns owned BM)
  const [bm] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
    arguments: [],
  });

  // 2. Split SUI from gas + deposit into BM
  const [depositCoin] = tx.splitCoins(tx.gas, [SUI_DEPOSIT_AMOUNT]);
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
    typeArguments: [SUI_TYPE_TAG],
    arguments: [bm, depositCoin],
  });

  // 3. Build pools vector + create ExecutorAgent
  const poolsBytes = bcs.vector(bcs.Address).serialize(allowedPools).toBytes();
  const [agent] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::create_agent`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      bm,
      tx.pure(bcs.Address.serialize(executorAddr).toBytes()),
      tx.pure(poolsBytes),
      tx.pure(bcs.U64.serialize(MAX_PER_TRADE_NOTIONAL).toBytes()),
      tx.pure(bcs.U64.serialize(MAX_PER_DAY_NOTIONAL).toBytes()),
      tx.pure(bcs.U64.serialize(expiresAtMs).toBytes()),
      tx.object('0x6'),
    ],
  });

  // 4. Share ExecutorAgent
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::share`,
    arguments: [agent],
  });

  // 5. Mint a DepositCap and transfer it to the backend executor address.
  //    This lets the backend call balance_manager::deposit_with_cap<T> to fund
  //    the user's BM on demand (e.g. via the /deposit Telegram command) without
  //    requiring the user's wallet signature each time.
  const [depositCap] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::mint_deposit_cap`,
    arguments: [bm],
  });
  tx.transferObjects([depositCap], executorAddr);

  // 6. Share BalanceManager so backend can mutate it on user's behalf
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [`${DEEPBOOK_PACKAGE_ID}::balance_manager::BalanceManager`],
    arguments: [bm],
  });

  tx.setSender(address);
  tx.setGasBudget(300_000_000);

  console.log('executing setup PTB...');
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
  console.log(`status:  ${inner.status?.success}`);
  if (inner.status?.error) console.log(`error:   ${inner.status.error}`);
  if (!inner.digest) throw new Error('no digest returned');
  if (inner.status?.success === false) {
    throw new Error(`setup tx failed: ${inner.status?.error ?? 'unknown'}`);
  }

  // Fetch object IDs from the transaction effects. The tx is submitted but
  // suiGrpc.getTransaction may return NOT_FOUND for ~2-5s while the
  // checkpoint with this tx finalises and propagates to the read service.
  // Retry with backoff.
  console.log('waiting for tx finality...');
  let txInfo: { objectChanges?: Array<{ type?: string; objectId?: string; objectType?: string }> } | null = null;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      txInfo = (await suiGrpc.getTransaction({
        digest: inner.digest,
        options: { showObjectChanges: true },
      })) as unknown as typeof txInfo;
      if (txInfo) break;
    } catch (e) {
      const msg = (e as Error).message || '';
      if (!msg.includes('NOT_FOUND')) throw e;
      // keep polling
    }
  }
  if (!txInfo) throw new Error('tx never appeared via getTransaction after ~16s');
  const created = (txInfo.objectChanges ?? []).filter((c) => c.type === 'created');
  const bmObj = created.find((c) => c.objectType?.endsWith('::balance_manager::BalanceManager'));
  const agentObj = created.find((c) =>
    c.objectType?.endsWith('::executor::ExecutorAgent'),
  );
  const depositCapObj = created.find((c) =>
    c.objectType?.endsWith('::balance_manager::DepositCap'),
  );
  if (!bmObj?.objectId || !agentObj?.objectId) {
    console.error('expected BM + Agent in created objects; got:', created);
    throw new Error('could not extract BM/Agent IDs');
  }

  console.log(`\nNew BalanceManager: ${bmObj.objectId}`);
  console.log(`New ExecutorAgent:  ${agentObj.objectId}`);
  if (depositCapObj?.objectId) console.log(`New DepositCap:     ${depositCapObj.objectId}`);

  // Update the user's TraderProfile in Postgres.
  console.log('\nupdating TraderProfile in Postgres...');
  const updated = await prismaQuery.traderProfile.updateMany({
    where: { sui_address: address },
    data: {
      balance_manager_id: bmObj.objectId,
      executor_agent_id: agentObj.objectId,
      ...(depositCapObj?.objectId ? { deposit_cap_id: depositCapObj.objectId } : {}),
    },
  });
  console.log(`rows updated: ${updated.count}`);
  if (updated.count === 0) {
    console.warn(
      '⚠️  No TraderProfile found for this address. Make sure the user has ' +
        'signed in via the bot first (so the row exists), then re-run.',
    );
  }

  console.log('\nDONE. Next:');
  console.log(`  - Telegram: /trade buy SUI 0.1 @5.00 (price out of band so it rests as an open order)`);
  console.log(`  - Explorer: https://suiscan.xyz/testnet/tx/${inner.digest}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('failed:', err);
    process.exit(1);
  });
