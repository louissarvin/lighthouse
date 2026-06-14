/**
 * scripts/deposit-dusdc-to-manager.ts
 *
 * Deposits DUSDC from the executor's wallet into the PredictManager so the
 * Telegram /predict flow has quote currency to mint binary positions.
 *
 * Idempotent: safe to re-run any time the manager balance gets low.
 *
 * Usage:
 *   bun run scripts/deposit-dusdc-to-manager.ts [amount_in_dusdc]
 *
 * Default deposit: 100 DUSDC (= 100_000_000 raw units, 6 decimals).
 */

import { buildPredictDepositTx } from '../src/lib/predict.ts';
import { getExecutorKeypair } from '../src/lib/keypairs.ts';
import { suiGrpc, suiRpc } from '../src/lib/sui.ts';
import {
  PREDICT_MANAGER_ID,
  DUSDC_TYPE_TAG,
} from '../src/config/main-config.ts';

// Typed cast for getOwnedObjects — same pattern as DepositService.ts.
// suiRpc.getCoins() does not exist on SuiJsonRpcClient; silently throws.
const ownedRpc = suiRpc as unknown as {
  getOwnedObjects: (args: {
    owner: string;
    filter?: { StructType?: string };
    options?: { showContent?: boolean };
  }) => Promise<{
    data?: Array<{
      data?: {
        objectId?: string;
        version?: string;
        digest?: string;
        content?: { fields?: { balance?: string } };
      };
    }>;
  }>;
};

interface ExecResult {
  Transaction?: {
    digest?: string;
    status?: { success?: boolean; error?: string | null };
  };
  digest?: string;
}

async function main(): Promise<void> {
  if (!PREDICT_MANAGER_ID) {
    console.error('[predict-deposit] PREDICT_MANAGER_ID not set. Run setup-predict-manager.ts first.');
    process.exit(1);
  }

  const amountArg = process.argv[2];
  const amountDusdc = amountArg ? parseFloat(amountArg) : 100;
  if (!Number.isFinite(amountDusdc) || amountDusdc <= 0) {
    console.error(`[predict-deposit] invalid amount: ${amountArg}`);
    process.exit(1);
  }
  // DUSDC has 6 decimals on testnet.
  const amountRaw = BigInt(Math.floor(amountDusdc * 1_000_000));

  const keypair = getExecutorKeypair();
  const executorAddr = keypair.toSuiAddress();
  console.log(`[predict-deposit] executor: ${executorAddr}`);
  console.log(`[predict-deposit] manager:  ${PREDICT_MANAGER_ID}`);
  console.log(`[predict-deposit] amount:   ${amountDusdc} DUSDC (${amountRaw} raw)`);

  // Find a DUSDC coin owned by the executor with sufficient balance.
  // We use getOwnedObjects instead of getCoins — the latter silently fails on
  // SuiJsonRpcClient (same fix applied throughout the codebase).
  const DUSDC_STRUCT = `0x2::coin::Coin<${DUSDC_TYPE_TAG}>`;
  const ownedResp = await ownedRpc.getOwnedObjects({
    owner: executorAddr,
    filter: { StructType: DUSDC_STRUCT },
    options: { showContent: true },
  });

  const candidates = (ownedResp.data ?? []).filter((c) => {
    const bal = c.data?.content?.fields?.balance;
    return (
      !!c.data?.objectId &&
      !!c.data?.version &&
      !!c.data?.digest &&
      bal != null &&
      BigInt(bal) >= amountRaw
    );
  });

  if (candidates.length === 0) {
    // Show total balance across all DUSDC coins for diagnostics.
    const allCoins = (ownedResp.data ?? []).filter((c) => c.data?.content?.fields?.balance != null);
    const total = allCoins.reduce(
      (acc, c) => acc + BigInt(c.data?.content?.fields?.balance ?? '0'),
      0n,
    );
    console.error(
      `[predict-deposit] no DUSDC coin >= ${amountRaw} raw found at executor. ` +
        `Total DUSDC: ${total} raw across ${allCoins.length} coin(s).\n` +
        `Transfer DUSDC to executor first: ${executorAddr}`,
    );
    process.exit(1);
  }
  // Sort largest first.
  candidates.sort((a, b) => {
    const ba = BigInt(b.data?.content?.fields?.balance ?? '0');
    const aa = BigInt(a.data?.content?.fields?.balance ?? '0');
    return ba > aa ? 1 : ba < aa ? -1 : 0;
  });
  const coinEntry = candidates[0].data!;
  const coin = {
    coinObjectId: coinEntry.objectId!,
    version: coinEntry.version!,
    digest: coinEntry.digest!,
    balance: coinEntry.content?.fields?.balance ?? '0',
  };
  console.log(`[predict-deposit] using coin: ${coin.coinObjectId} (balance: ${coin.balance})`);

  const tx = buildPredictDepositTx({
    managerObjectId: PREDICT_MANAGER_ID!,
    coinObjectId: coin.coinObjectId,
    coinTypeTag: DUSDC_TYPE_TAG,
  });
  tx.setSender(executorAddr);
  tx.setGasBudget(50_000_000);

  console.log('[predict-deposit] submitting deposit tx...');
  const result = (await suiGrpc.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  })) as ExecResult;
  const inner = result.Transaction ?? {};
  const digest = inner.digest ?? result.digest;
  console.log(`[predict-deposit] digest:  ${digest}`);
  console.log(`[predict-deposit] success: ${inner.status?.success}`);
  if (inner.status?.error) {
    console.error(`[predict-deposit] error:   ${inner.status.error}`);
    process.exit(1);
  }

  console.log('[predict-deposit] ✅ DUSDC deposited into PredictManager.');
  console.log(`[predict-deposit] explorer: https://suiscan.xyz/testnet/tx/${digest}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[predict-deposit] failed:', err);
    process.exit(1);
  });
