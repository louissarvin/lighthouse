/**
 * DeepBook v3 helpers.
 *
 * Source:
 *   - docs.sui.io/onchain-finance/deepbookv3/deepbook
 *   - memory/deepbook_reverify_2026_06.md
 *
 * NOTE on SDK usage: `@mysten/deepbook-v3` exposes `placeLimitOrder` that
 * builds a PTB calling `pool::place_limit_order` DIRECTLY. That skips our
 * `lighthouse::executor::place_limit_under_budget` wrapper (and therefore our
 * budget + pool-whitelist defenses). So we hand-roll the PTB for trades.
 *
 * The DeepBook SDK is still useful for READ queries (orderbook snapshots,
 * balance manager balances). We do not wire those here — add when needed.
 *
 * Testnet IDs are in `memory/lighthouse_testnet_plan_2026_06.md` §1.4.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import {
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_SUI_DBUSDC_POOL,
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../config/main-config.ts';

/**
 * DeepBook v3 `place_limit_order` enum constants. Pin these so the Coach can
 * reason about types symbolically.
 */
export const ORDER_TYPE = {
  /// No restrictions.
  NO_RESTRICTION: 0,
  /// Cancel taker (would-cross is rejected).
  CANCEL_TAKER: 1,
  /// Immediate or cancel.
  IOC: 2,
  /// Fill or kill.
  FOK: 3,
} as const;

export const SELF_MATCHING = {
  ALLOWED: 0,
  CANCEL_TAKER: 1,
  CANCEL_MAKER: 2,
} as const;

export interface PlaceLimitArgs {
  /// Shared `ExecutorAgent` object ID (owned by the user, agent_address = backend).
  executorAgentId: string;
  /// Shared `BalanceManager` object ID.
  balanceManagerId: string;
  /// Pool object ID (e.g. `DEEPBOOK_SUI_DBUSDC_POOL`).
  poolId?: string;
  /// Pool generic params: `<Base, Quote>` type tags as full strings, e.g.
  /// `0x2::sui::SUI` and `0x...::DBUSDC::DBUSDC`. Required because we hand-roll
  /// the typed `moveCall`.
  baseType: string;
  quoteType: string;

  clientOrderId: bigint;
  orderType: number;
  selfMatching: number;
  /// FLOAT_SCALING'd price (u64 → bigint).
  price: bigint;
  /// Base raw units (u64 → bigint).
  quantity: bigint;
  /// true = buy (bid), false = sell (ask).
  isBid: boolean;
  /// Whether to pay fees in DEEP (vs base/quote).
  payWithDeep: boolean;
  /// Order expiry timestamp (Unix ms, u64 → bigint). 0 = no expiry.
  expireTimestamp: bigint;

  /// If provided, ALSO bundle an `audit_anchor::record(kind=trade)` +
  /// `transfer_to_owner(anchor)` into the same PTB (LIGHTHOUSE.md §10.5
  /// mandates this atomic composition). The Walrus blob ID should be the
  /// 32-byte u256 form via `bcs.u256().serialize(blobIdToInt(blobIdStr))`.
  /// Per spec §10.5 we pass an EMPTY tx_digest — the AnchorRecorded event's
  /// enclosing transaction IS the trade tx by definition; indexers join
  /// off-chain.
  auditWalrusBlobIdBytes?: Uint8Array;
}

/**
 * Build a PTB that calls `lighthouse::executor::place_limit_under_budget`.
 *
 * The caller signs this PTB with the EXECUTOR agent keypair (the address
 * recorded as `agent_address` on the ExecutorAgent).
 */
export function buildPlaceLimitTx(args: PlaceLimitArgs): Transaction {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_PACKAGE_ID is not set');
  }
  if (!LIGHTHOUSE_VERSION_OBJECT_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_VERSION_OBJECT_ID is not set');
  }
  const poolId = args.poolId ?? DEEPBOOK_SUI_DBUSDC_POOL;
  if (!poolId) {
    throw new Error('[deepbook] poolId not provided and no default pool configured');
  }

  const tx = new Transaction();

  // === Call 1: Place limit order through executor budget gate ===
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::place_limit_under_budget`,
    typeArguments: [args.baseType, args.quoteType],
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.executorAgentId),
      tx.object(args.balanceManagerId),
      tx.object(poolId),
      tx.pure(bcs.U64.serialize(args.clientOrderId).toBytes()),
      tx.pure(bcs.U8.serialize(args.orderType).toBytes()),
      tx.pure(bcs.U8.serialize(args.selfMatching).toBytes()),
      tx.pure(bcs.U64.serialize(args.price).toBytes()),
      tx.pure(bcs.U64.serialize(args.quantity).toBytes()),
      tx.pure(bcs.Bool.serialize(args.isBid).toBytes()),
      tx.pure(bcs.Bool.serialize(args.payWithDeep).toBytes()),
      tx.pure(bcs.U64.serialize(args.expireTimestamp).toBytes()),
      tx.object('0x6'), // sui::clock::Clock
    ],
  });

  // === Calls 2+3: Audit anchor in SAME PTB (LIGHTHOUSE.md §10.5) ===
  // Per spec line "Bundle audit anchor in same PTB" — atomic with trade.
  // CRITICAL: AuditAnchor has key+store, NO drop. We must transfer or share
  // the returned value or the PTB aborts with "Unused value without drop".
  if (args.auditWalrusBlobIdBytes) {
    if (args.auditWalrusBlobIdBytes.length === 0) {
      throw new Error('[deepbook] auditWalrusBlobIdBytes must be non-empty');
    }
    const [anchor] = tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
      arguments: [
        tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
        tx.pure(bcs.U8.serialize(1).toBytes()), // kind=1 (trade)
        tx.pure(
          bcs
            .vector(bcs.U8)
            .serialize(Array.from(args.auditWalrusBlobIdBytes))
            .toBytes(),
        ),
        // Empty 32-byte digest — per §10.5: "AnchorRecorded event's enclosing
        // transaction IS the trade tx by definition; join via Sui RPC off-chain."
        tx.pure(
          bcs
            .vector(bcs.U8)
            .serialize(Array.from(new Uint8Array(32)))
            .toBytes(),
        ),
        tx.object('0x6'),
      ],
    });
    tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
      arguments: [anchor],
    });
  }

  return tx;
}

// ============================================================================
// Deposit — backend-signed top-up via DepositCap
// ============================================================================

/**
 * Build a PTB that deposits `amount` of `coinType` into a user's BalanceManager.
 *
 * Requires the backend executor to hold the user's `DepositCap` (an owned object
 * transferred to the executor during user setup). The executor signs and pays gas,
 * so the user never needs to touch their wallet for top-ups.
 *
 * The SUI being deposited is split from the executor's own gas coin, so the
 * executor wallet must have sufficient balance.
 */
export function buildDepositTx(
  balanceManagerId: string,
  depositCapId: string,
  amount: bigint,
  coinType: string,
): Transaction {
  if (!DEEPBOOK_PACKAGE_ID) {
    throw new Error('[deepbook] DEEPBOOK_PACKAGE_ID is not set');
  }
  const tx = new Transaction();
  // Split the deposit amount from the executor's gas coin.
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit_with_cap`,
    typeArguments: [coinType],
    arguments: [
      tx.object(balanceManagerId),
      tx.object(depositCapId),
      coin,
    ],
  });
  return tx;
}

// ============================================================================
// §10.4 — Onboarding mega-PTB (6 calls in 1 atomic tx)
// ============================================================================

export interface OnboardingArgs {
  /// User's USDC Coin object ID to deposit into the new BalanceManager.
  /// Optional — if omitted, BM is created empty (user can deposit later).
  usdcCoinId?: string;
  /// Optional DEEP Coin object ID for fee-discount deposit.
  deepCoinId?: string;
  /// USDC type tag for `deposit` generic (e.g. `0x...::DBUSDC::DBUSDC`).
  /// Required if `usdcCoinId` provided.
  usdcType?: string;
  /// DEEP type tag. Required if `deepCoinId` provided.
  deepType?: string;
  /// Set true to ALSO share the BM in the same PTB (so executor can mutate it).
  shareBalanceManager: boolean;
}

/**
 * Build the §10.4 one-shot onboarding PTB. User signs ONCE; we get back BM +
 * TraderProfile object IDs from `objectChanges` and persist them.
 *
 * Call sequence (atomic):
 *   1. balance_manager::new                              → returns BM
 *   2. balance_manager::deposit<USDC>(bm, usdc_coin)     (optional)
 *   3. balance_manager::deposit<DEEP>(bm, deep_coin)     (optional, fee discount)
 *   4. trader_profile::create(version, clock)            → returns profile
 *   5. trader_profile::share(profile)
 *   6. transfer::public_share_object<BM>(bm)             (if shareBalanceManager)
 *
 * Source: LIGHTHOUSE.md §10.4 + verified BM signatures from
 * `@mysten/deepbook-v3@1.4.1/dist/transactions/balanceManager.mjs`.
 */
export function buildOnboardingTx(args: OnboardingArgs): Transaction {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_PACKAGE_ID is not set');
  }
  if (!LIGHTHOUSE_VERSION_OBJECT_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_VERSION_OBJECT_ID is not set');
  }
  if (args.usdcCoinId && !args.usdcType) {
    throw new Error('[deepbook] usdcType required when usdcCoinId is provided');
  }
  if (args.deepCoinId && !args.deepType) {
    throw new Error('[deepbook] deepType required when deepCoinId is provided');
  }
  if (!DEEPBOOK_PACKAGE_ID) {
    throw new Error('[deepbook] DEEPBOOK_PACKAGE_ID is not set');
  }

  const tx = new Transaction();

  // === 1. Create BalanceManager (returns the new BM as a PTB result) ===
  const [bm] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
    arguments: [],
  });

  // === 2. Optional USDC deposit ===
  if (args.usdcCoinId) {
    tx.moveCall({
      target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
      typeArguments: [args.usdcType!],
      arguments: [bm, tx.object(args.usdcCoinId)],
    });
  }

  // === 3. Optional DEEP deposit (fee discount per §10.6 gotcha 2) ===
  if (args.deepCoinId) {
    tx.moveCall({
      target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
      typeArguments: [args.deepType!],
      arguments: [bm, tx.object(args.deepCoinId)],
    });
  }

  // === 4. Create TraderProfile ===
  const [profile] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::create`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object('0x6'),
    ],
  });

  // === 5. Share TraderProfile (SEAL key servers need shared-object access) ===
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::share`,
    arguments: [profile],
  });

  // === 6. Share BalanceManager so executor can mutate ===
  // (Skip if caller wants to keep BM owned, e.g. for advanced flows.)
  if (args.shareBalanceManager) {
    tx.moveCall({
      target: `0x2::transfer::public_share_object`,
      typeArguments: [`${DEEPBOOK_PACKAGE_ID}::balance_manager::BalanceManager`],
      arguments: [bm],
    });
  }

  return tx;
}

/**
 * Build a PTB that mints + shares an `ExecutorAgent` for the user. The user
 * signs this (they own the BalanceManager).
 */
export interface CreateAgentArgs {
  balanceManagerId: string;
  agentAddress: string;
  allowedPools: string[];
  maxPerTrade: bigint;
  maxPerDay: bigint;
  expiresAtMs: bigint;
}

export function buildCreateAgentTx(args: CreateAgentArgs): Transaction {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_PACKAGE_ID is not set');
  }
  if (!LIGHTHOUSE_VERSION_OBJECT_ID) {
    throw new Error('[deepbook] LIGHTHOUSE_VERSION_OBJECT_ID is not set');
  }

  const tx = new Transaction();
  const poolsBytes = bcs.vector(bcs.Address).serialize(args.allowedPools).toBytes();

  const [agent] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::create_agent`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      tx.object(args.balanceManagerId),
      tx.pure(bcs.Address.serialize(args.agentAddress).toBytes()),
      tx.pure(poolsBytes),
      tx.pure(bcs.U64.serialize(args.maxPerTrade).toBytes()),
      tx.pure(bcs.U64.serialize(args.maxPerDay).toBytes()),
      tx.pure(bcs.U64.serialize(args.expiresAtMs).toBytes()),
      tx.object('0x6'),
    ],
  });

  // Share the agent so the backend can drive it from any PTB.
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::share`,
    arguments: [agent],
  });

  return tx;
}
