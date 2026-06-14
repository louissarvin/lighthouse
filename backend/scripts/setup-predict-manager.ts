/**
 * scripts/setup-predict-manager.ts
 *
 * One-time setup script: creates a PredictManager owned by the backend
 * executor address. The resulting object id is written to PREDICT_MANAGER_ID
 * and consumed by the Telegram `/predict` flow.
 *
 * The executor needs only a tiny amount of SUI to cover gas (~0.01 SUI).
 *
 * Usage:
 *   bun run scripts/setup-predict-manager.ts
 *
 * After it runs, copy the printed object id into .env:
 *   PREDICT_MANAGER_ID=0x...
 */

import { buildCreatePredictManagerTx } from '../src/lib/predict.ts';
import { getExecutorKeypair } from '../src/lib/keypairs.ts';
import { suiGrpc } from '../src/lib/sui.ts';
import { suiRpc } from '../src/lib/sui.ts';

interface ExecResult {
  Transaction?: {
    digest?: string;
    status?: { success?: boolean; error?: string | null };
  };
  digest?: string;
}

interface ObjectChange {
  type?: string;
  objectType?: string;
  objectId?: string;
  owner?: unknown;
}

async function main(): Promise<void> {
  const keypair = getExecutorKeypair();
  const executorAddr = keypair.toSuiAddress();
  console.log(`[predict-setup] executor: ${executorAddr}`);

  const tx = buildCreatePredictManagerTx();
  tx.setSender(executorAddr);
  tx.setGasBudget(100_000_000);

  console.log('[predict-setup] submitting create_manager tx...');
  const result = (await suiGrpc.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  })) as ExecResult;
  const inner = result.Transaction ?? {};
  const digest = inner.digest ?? result.digest;
  console.log(`[predict-setup] digest:  ${digest}`);
  console.log(`[predict-setup] success: ${inner.status?.success}`);
  if (inner.status?.error) {
    console.error(`[predict-setup] error:   ${inner.status.error}`);
    process.exit(1);
  }
  if (!digest) {
    console.error('[predict-setup] no digest returned');
    process.exit(1);
  }

  // Wait briefly for the tx to be indexed by the JSON-RPC node, then pull
  // objectChanges to find the created PredictManager.
  await new Promise((r) => setTimeout(r, 3000));

  const tb = (await suiRpc.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  })) as { objectChanges?: ObjectChange[] };

  const changes = tb.objectChanges ?? [];
  const managerChange = changes.find(
    (c) =>
      (c.type === 'created' || c.type === 'mutated') &&
      typeof c.objectType === 'string' &&
      c.objectType.includes('predict_manager::PredictManager'),
  );

  if (!managerChange?.objectId) {
    console.error('[predict-setup] could not locate PredictManager in objectChanges:');
    console.error(JSON.stringify(changes, null, 2));
    process.exit(1);
  }

  console.log(`[predict-setup] ✅ PredictManager created: ${managerChange.objectId}`);
  console.log(`[predict-setup] explorer: https://suiscan.xyz/testnet/object/${managerChange.objectId}`);
  console.log('');
  console.log(`👉 Add to .env: PREDICT_MANAGER_ID=${managerChange.objectId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[predict-setup] failed:', err);
    process.exit(1);
  });
