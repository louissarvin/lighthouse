/**
 * scripts/live-test-messaging.ts
 *
 * Verifies the Sui Stack Messaging wire end-to-end:
 *   1. RELAYER_URL is reachable
 *   2. getMessaging() returns enabled client
 *   3. createGroupAsCoach succeeds (Coach signs + pays)
 *
 * Requires:
 *   - Relayer running at RELAYER_URL (default http://localhost:3000)
 *   - Coach keypair funded with SUI + WAL (already done earlier)
 */

import { createGroupAsCoach } from '../src/lib/messaging.ts';
import { RELAYER_URL } from '../src/config/main-config.ts';

async function main(): Promise<void> {
  console.log(`relayer: ${RELAYER_URL}`);
  console.log('creating test group as Coach...');

  // Use the dev address as initial member. Coach is auto-granted permissions.
  const result = await createGroupAsCoach({
    name: `Lighthouse · live-test · ${new Date().toISOString()}`,
    members: ['0xa2b8c5d575ea1330fe68967d9d67570d9b1d4007ec813c39e6fbddacdb1da872'],
  });

  console.log(`uuid:    ${result.uuid}`);
  console.log(`digest:  ${result.digest}`);
  console.log(`explorer: https://suiscan.xyz/testnet/tx/${result.digest}`);
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
