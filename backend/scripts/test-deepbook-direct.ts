/**
 * Standalone test: place a limit order directly via the DeepBook v3 SDK
 * (bypassing our executor). Verifies the on-chain pool actually accepts
 * orders right now. If THIS succeeds, the issue is our executor's linkage
 * to a disabled DeepBook version, fixable by re-publishing Lighthouse
 * against the original DeepBook published id.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { getExecutorKeypair } from '../src/lib/keypairs.ts';
import { suiGrpc } from '../src/lib/sui.ts';

// NOTE: Calling DeepBook directly from this script will fail with
// EPackageVersionDisabled (abort code 11) because:
//   - Pool allowed_versions = {1,2,3,4,5}
//   - The canonical package 0x22be4c... routes to the latest upgrade (v19)
//     which has CURRENT_VERSION = 8
//
// After upgrading Lighthouse to DeepBook testnet-v17 (CURRENT_VERSION=5),
// the correct test path is through the Lighthouse executor, NOT direct pool calls.
// This script now uses the canonical package ID as documentation; it will still
// fail on pool::place_limit_order but the error message will confirm the version
// mismatch rather than a contract logic error.
const ORIGINAL_DEEPBOOK = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';
const SUI_DBUSDC_POOL = '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5';
const BM = '0x6ad88496e8507a205d60b418f08fd939716cbc6a43fdf9453ed404fb3de4ebf8';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DBUSDC_TYPE = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';

async function main(): Promise<void> {
  const executor = getExecutorKeypair();
  const tx = new Transaction();

  // Generate trade proof for BM (assumes BM is shared and we have a TradeCap
  // but we test without one — just trying to call to see what aborts).
  const [proof] = tx.moveCall({
    target: `${ORIGINAL_DEEPBOOK}::balance_manager::generate_proof_as_owner`,
    arguments: [tx.object(BM)],
  });

  // Place a SELL 0.05 SUI @ 5.00 DBUSDC limit order.
  // price encoding: 5.00 * 1e9 * 1e6 / 1e9 = 5_000_000
  // qty: 0.05 * 1e9 = 50_000_000
  tx.moveCall({
    target: `${ORIGINAL_DEEPBOOK}::pool::place_limit_order`,
    typeArguments: [SUI_TYPE, DBUSDC_TYPE],
    arguments: [
      tx.object(SUI_DBUSDC_POOL),
      tx.object(BM),
      proof,
      tx.pure(bcs.U64.serialize(BigInt(Date.now())).toBytes()),
      tx.pure(bcs.U8.serialize(0).toBytes()),     // order_type: no_restriction
      tx.pure(bcs.U8.serialize(0).toBytes()),     // self_matching: allowed
      tx.pure(bcs.U64.serialize(5_000_000n).toBytes()),    // price
      tx.pure(bcs.U64.serialize(50_000_000n).toBytes()),   // qty
      tx.pure(bcs.Bool.serialize(false).toBytes()), // is_bid (sell)
      tx.pure(bcs.Bool.serialize(false).toBytes()), // pay_with_deep
      tx.pure(bcs.U64.serialize(0n).toBytes()),    // expire (none)
      tx.object('0x6'),                            // clock
    ],
  });

  tx.setSender(executor.toSuiAddress());
  tx.setGasBudget(100_000_000);

  console.log('executing direct DeepBook order via ORIGINAL deepbook id...');
  try {
    const result = (await suiGrpc.signAndExecuteTransaction({
      signer: executor,
      transaction: tx,
    })) as { Transaction?: { digest?: string; status?: { success?: boolean; error?: string | null } } };
    const inner = result.Transaction ?? {};
    console.log(`digest:  ${inner.digest}`);
    console.log(`success: ${inner.status?.success}`);
    if (inner.status?.error) console.log(`error:   ${inner.status.error}`);
  } catch (e) {
    console.error('throw:', (e as Error).message.slice(0, 400));
  }
}

main().catch((e) => {
  console.error('failed:', (e as Error).message);
  process.exit(1);
});
