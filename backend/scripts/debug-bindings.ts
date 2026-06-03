/**
 * Diagnostic: dumps recent TraderProfile + TelegramUser rows so we can see
 * exactly what OAuth onboarding wrote (or didn't write) to the database.
 *
 * Usage:  bun run scripts/debug-bindings.ts
 */

import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

async function main(): Promise<void> {
  console.log('\n=== Recent TraderProfile rows (last 10) ===\n');
  const profiles = await prismaQuery.traderProfile.findMany({
    orderBy: { created_at: 'desc' },
    take: 10,
    include: { telegram: true },
  });
  for (const p of profiles) {
    console.log({
      id: p.id,
      sui_address: p.sui_address,
      profile_object_id: p.profile_object_id,
      balance_manager_id: p.balance_manager_id,
      executor_agent_id: p.executor_agent_id,
      deposit_cap_id: p.deposit_cap_id,
      memwal_account_id: p.memwal_account_id,
      risk_profile_completed_at: p.risk_profile_completed_at,
      created_at: p.created_at,
      telegram_binding: p.telegram
        ? {
            id: p.telegram.id,
            hash_prefix: p.telegram.telegram_user_id_hash.slice(0, 12) + '…',
            chat_id: p.telegram.telegram_chat_id?.toString() ?? null,
            username: p.telegram.telegram_username,
          }
        : null,
    });
    console.log('---');
  }

  console.log('\n=== Recent TelegramUser rows (last 10) ===\n');
  const tgUsers = await prismaQuery.telegramUser.findMany({
    orderBy: { created_at: 'desc' },
    take: 10,
    include: { trader_profile: true },
  });
  for (const t of tgUsers) {
    console.log({
      id: t.id,
      hash_prefix: t.telegram_user_id_hash.slice(0, 12) + '…',
      chat_id: t.telegram_chat_id?.toString() ?? null,
      trader_profile_id: t.trader_profile_id,
      bound_sui_address: t.trader_profile?.sui_address,
      created_at: t.created_at,
    });
    console.log('---');
  }

  console.log('\n=== Recent OAuthNonce rows (last 5) ===\n');
  const nonces = await prismaQuery.oAuthNonce.findMany({
    orderBy: { created_at: 'desc' },
    take: 5,
    select: {
      nonce: true,
      telegram_user_id_hash: true,
      origin: true,
      action: true,
      consumed_at: true,
      expires_at: true,
      created_at: true,
    },
  });
  for (const n of nonces) {
    console.log({
      nonce_prefix: n.nonce.slice(0, 10) + '…',
      hash_prefix: n.telegram_user_id_hash.slice(0, 12) + '…',
      origin: n.origin,
      action: n.action,
      consumed: n.consumed_at ? 'YES' : 'no',
      expired: n.expires_at < new Date() ? 'YES' : 'no',
      created_at: n.created_at,
    });
    console.log('---');
  }

  console.log('\nDone.\n');
  await prismaQuery.$disconnect();
}

void main().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
