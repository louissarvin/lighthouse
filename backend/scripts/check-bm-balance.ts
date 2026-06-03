/**
 * Read a TraderProfile + ask Sui directly for the BalanceManager + wallet
 * balances. Bypasses the /balance cache so we see ground truth.
 *
 * Usage:  bun run scripts/check-bm-balance.ts
 */

import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { suiRpc } from '../src/lib/sui.ts';

const SUI_TYPE = '0x2::sui::SUI';

async function main(): Promise<void> {
  const profile = await prismaQuery.traderProfile.findFirst({
    orderBy: { created_at: 'desc' },
    include: { telegram: true },
  });
  if (!profile) {
    console.log('No TraderProfile found.');
    return;
  }

  console.log('\n=== Latest TraderProfile ===');
  console.log({
    id: profile.id,
    sui_address: profile.sui_address,
    balance_manager_id: profile.balance_manager_id,
    executor_agent_id: profile.executor_agent_id,
    deposit_cap_id: profile.deposit_cap_id,
    predict_manager_id: profile.predict_manager_id,
  });

  const rpc = suiRpc as unknown as {
    getBalance: (args: {
      owner: string;
      coinType?: string;
    }) => Promise<{ totalBalance: string }>;
    getObject: (args: {
      id: string;
      options?: { showContent?: boolean; showOwner?: boolean };
    }) => Promise<unknown>;
    getDynamicFields: (args: {
      parentId: string;
      cursor?: string;
      limit?: number;
    }) => Promise<{ data: Array<{ name: unknown; objectId: string }> }>;
  };

  console.log('\n=== Wallet SUI balance (user bound address) ===');
  try {
    const bal = await rpc.getBalance({ owner: profile.sui_address, coinType: SUI_TYPE });
    console.log(`SUI MIST: ${bal.totalBalance}`);
    console.log(`SUI: ${(Number(bal.totalBalance) / 1e9).toFixed(6)}`);
  } catch (e) {
    console.log('getBalance failed:', (e as Error).message);
  }

  if (!profile.balance_manager_id) {
    console.log('\nNo balance_manager_id set; skipping BM checks.');
    return;
  }

  console.log('\n=== BalanceManager object ===');
  try {
    const obj = await rpc.getObject({
      id: profile.balance_manager_id,
      options: { showContent: true, showOwner: true },
    });
    console.log(JSON.stringify(obj, null, 2).slice(0, 1500) + '...');
  } catch (e) {
    console.log('getObject(BM) failed:', (e as Error).message);
  }

  console.log('\n=== Executor address SUI balance ===');
  // Best-effort: hard-code if you know it, or look up via env.
  const executorAddrEnv = process.env.EXECUTOR_AGENT_ADDRESS;
  if (executorAddrEnv) {
    try {
      const bal = await rpc.getBalance({ owner: executorAddrEnv, coinType: SUI_TYPE });
      console.log(`Executor (${executorAddrEnv.slice(0, 10)}...):`);
      console.log(`  SUI MIST: ${bal.totalBalance}`);
      console.log(`  SUI: ${(Number(bal.totalBalance) / 1e9).toFixed(6)}`);
    } catch (e) {
      console.log('getBalance(executor) failed:', (e as Error).message);
    }
  } else {
    console.log('(set EXECUTOR_AGENT_ADDRESS env var to also check executor)');
  }

  console.log('\n=== Recent PendingDeposit rows ===');
  const pending = await prismaQuery.pendingDeposit.findMany({
    where: { trader_profile_id: profile.id },
    orderBy: { created_at: 'desc' },
    take: 5,
  });
  for (const p of pending) {
    console.log({
      id: p.id.slice(0, 10) + '...',
      amount_mist: p.amount_mist.toString(),
      status: p.status,
      expected_sender: p.expected_sender_address?.slice(0, 10) + '...',
      swept_tx: p.swept_tx_digest?.slice(0, 10) + '...',
      claimed_from: p.claimed_from_tx_digest?.slice(0, 10) + '...',
      created: p.created_at,
    });
  }

  await prismaQuery.$disconnect();
}

void main().catch((e) => {
  console.error('Check failed:', e);
  process.exit(1);
});
