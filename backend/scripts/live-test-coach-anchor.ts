/**
 * scripts/live-test-coach-anchor.ts
 *
 * Live tests the coachAnchor flow that the Telegram bot's
 * "💾 Save & Anchor" button uses:
 *   1. anchorText(text) uploads to Walrus
 *   2. Builds buildAuditAnchorTx, signs with Coach keypair
 *   3. Executes on testnet
 *
 * No Telegram involved. Pure integration test of the backend flow.
 */

import { anchorText } from '../src/lib/coachAnchor.ts';

async function main(): Promise<void> {
  const sampleConversation =
    `Q: should I buy SUI at 2.40?\n\n` +
    `A: Your risk profile (moderate, 5% per-trade cap) plus today's volatility ` +
    `(spread 0.4%) makes this a sized-1.5 SUI test trade. Wait for 5m close > 2.41.\n\n` +
    `[telegram:wire-test@${new Date().toISOString()}]`;

  console.log('uploading + anchoring...');
  console.log(`  payload length: ${sampleConversation.length} bytes`);

  const r = await anchorText(sampleConversation);

  console.log('\nDONE');
  console.log(`  tx digest:    ${r.digest}`);
  console.log(`  walrus blob:  ${r.blobId}`);
  console.log(`  explorer:     ${r.explorerUrl}`);
  console.log(`  walrus url:   ${r.blobUrl}`);
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
