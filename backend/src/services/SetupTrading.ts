/**
 * SetupTrading — auto-bootstrap a user's trading state right after OAuth.
 *
 * Triggered from /oauth/callback once the JWT + ephemeral keypair are fresh.
 * Pulls the architecture from LIGHTHOUSE.md §3.2 UC1 + §4.4:
 *
 *   1. Coach keypair drips a small amount of SUI to the user's zkLogin
 *      address (promotional credit). Coach signs + pays gas.
 *
 *   2. Wait for finality + locate the dripped coin object in the user's
 *      address.
 *
 *   3. Build a single atomic PTB that the USER signs (via stored ephemeral
 *      key + zkLogin signature wrap):
 *        a. balance_manager::new                           → bm
 *        b. balance_manager::deposit<SUI>(bm, dripped_coin)
 *        c. executor::create_agent(..., agent_address=EXECUTOR_AGENT, ...)
 *                                                          → agent
 *        d. executor::share(agent)
 *        e. transfer::public_share_object<BM>(bm)
 *
 *   4. Wrap the PTB with sponsorForZkLoginUser → Enoki sponsors gas.
 *
 *   5. Execute via executeSponsoredAsZkLoginUser. Enoki pays gas, user's
 *      ephemeral key + zkLogin proof authorise the user-side signature.
 *
 *   6. Parse object IDs from tx effects, update TraderProfile in Postgres.
 *
 * Result: BalanceManager owned by user's zkLogin address (production-correct
 * for revocation + withdrawals), agent_address = backend EXECUTOR (so
 * every future trade is silent backend signing), funded with 0.1 SUI.
 *
 * Zero gas paid by the user. Zero post-onboarding signatures required.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import {
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_SUI_DBUSDC_POOL,
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../config/main-config.ts';
import { getCoachKeypair, getExecutorKeypair } from '../lib/keypairs.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { suiGrpc, suiRpc } from '../lib/sui.ts';
import {
  executeSponsoredAsZkLoginUser,
  type ZkLoginNonceState,
} from '../lib/zklogin.ts';

const SUI_TYPE_TAG = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DEEP_SUI_POOL = '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f';
const WAL_SUI_POOL = '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a';

// Trading-config defaults. Conservative for testnet demo.
const DRIP_AMOUNT_MIST = 100_000_000n;             // 0.1 SUI starter credit
const MAX_PER_TRADE_NOTIONAL = 1_000_000_000n;     // 1 SUI / 1000 DBUSDC raw
const MAX_PER_DAY_NOTIONAL = 10_000_000_000n;      // 10 SUI / 10K DBUSDC raw
const AGENT_LIFETIME_MS = 90n * 24n * 60n * 60n * 1000n; // 90 days

export interface SetupTradingResult {
  /// Already had BM + Agent — no work done.
  skipped: boolean;
  /// Coach's drip tx digest. null when skipped.
  dripDigest: string | null;
  /// User's sponsored setup PTB digest. null when skipped.
  setupDigest: string | null;
  /// New BM object id.
  balanceManagerId: string;
  /// New ExecutorAgent object id.
  executorAgentId: string;
  /// New DepositCap object id (minted in same PTB, owned by executor).
  /// null when skipped or when the cap object could not be located.
  depositCapId: string | null;
  /// Coach-paid drip amount in MIST.
  dripAmountMist: bigint;
}

/**
 * Sleep helper.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch the most-recently-acquired SUI coin owned by `owner` whose value
 * matches `amount` (in MIST). Retries with backoff for testnet read lag.
 */
async function findDrippedCoin(
  owner: string,
  amount: bigint,
  maxRetries = 8,
): Promise<{ objectId: string; version: string; digest: string }> {
  // Use JSON-RPC for the owned-objects query (gRPC client doesn't expose
  // the convenient filter shape we need here).
  const rpc = suiRpc as unknown as {
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
  for (let i = 0; i < maxRetries; i++) {
    await sleep(1500);
    try {
      const resp = await rpc.getOwnedObjects({
        owner,
        filter: { StructType: '0x2::coin::Coin<0x2::sui::SUI>' },
        options: { showContent: true },
      });
      const matches = (resp.data ?? []).filter((c) => {
        const bal = c.data?.content?.fields?.balance;
        return bal && BigInt(bal) === amount;
      });
      const m = matches[0]?.data;
      if (m?.objectId && m.version && m.digest) {
        return { objectId: m.objectId, version: m.version, digest: m.digest };
      }
    } catch {
      // keep polling
    }
  }
  throw new Error(`[setup-trading] no Coin<SUI> with balance=${amount} found for ${owner}`);
}

/**
 * Idempotent setup. If TraderProfile already has BM + Agent, returns early.
 */
export async function setupUserTrading(args: {
  traderProfileId: string;
  jwt: string;
  zklState: ZkLoginNonceState;
}): Promise<SetupTradingResult> {
  if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID || !DEEPBOOK_PACKAGE_ID) {
    throw new Error('[setup-trading] required package IDs missing in env');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.traderProfileId },
  });
  if (!profile) throw new Error(`[setup-trading] TraderProfile ${args.traderProfileId} not found`);

  // Idempotency: already configured? Return existing.
  if (profile.balance_manager_id && profile.executor_agent_id) {
    return {
      skipped: true,
      dripDigest: null,
      setupDigest: null,
      balanceManagerId: profile.balance_manager_id,
      executorAgentId: profile.executor_agent_id,
      depositCapId: profile.deposit_cap_id ?? null,
      dripAmountMist: 0n,
    };
  }

  const userAddress = profile.sui_address;
  const coach = getCoachKeypair();
  const executorAddress = getExecutorKeypair().toSuiAddress();

  // ── Phase 1: Coach drip ─────────────────────────────────────────────
  const dripTx = new Transaction();
  const [dripCoin] = dripTx.splitCoins(dripTx.gas, [DRIP_AMOUNT_MIST]);
  dripTx.transferObjects([dripCoin], dripTx.pure.address(userAddress));
  dripTx.setSender(coach.toSuiAddress());
  dripTx.setGasBudget(50_000_000);

  const builtDrip = await dripTx.build({ client: suiGrpc as never });
  const dripSig = await coach.signTransaction(builtDrip);
  const dripResult = (await suiGrpc.executeTransaction({
    transaction: builtDrip,
    signatures: [dripSig.signature],
  })) as { Transaction?: { digest?: string }; digest?: string };
  const dripDigest = dripResult.Transaction?.digest ?? dripResult.digest;
  if (!dripDigest) throw new Error('[setup-trading] Coach drip returned no digest');

  // ── Phase 2: Locate the dripped coin in the user's address ──────────
  const dripped = await findDrippedCoin(userAddress, DRIP_AMOUNT_MIST);

  // ── Phase 3: Build the mega-PTB (signed by user via zkLogin sponsor) ─
  const tx = new Transaction();

  // (a) New BalanceManager
  const [bm] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
    arguments: [],
  });

  // (b) Deposit the dripped SUI coin into the BM
  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
    typeArguments: [SUI_TYPE_TAG],
    arguments: [bm, tx.objectRef(dripped)],
  });

  // (c) Create ExecutorAgent with agent_address = backend EXECUTOR
  const allowedPools = [DEEPBOOK_SUI_DBUSDC_POOL, DEEP_SUI_POOL, WAL_SUI_POOL];
  const expiresAtMs = BigInt(Date.now()) + AGENT_LIFETIME_MS;
  const poolsBytes = bcs.vector(bcs.Address).serialize(allowedPools).toBytes();

  const [agent] = tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::create_agent`,
    arguments: [
      tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
      bm,
      tx.pure(bcs.Address.serialize(executorAddress).toBytes()),
      tx.pure(poolsBytes),
      tx.pure(bcs.U64.serialize(MAX_PER_TRADE_NOTIONAL).toBytes()),
      tx.pure(bcs.U64.serialize(MAX_PER_DAY_NOTIONAL).toBytes()),
      tx.pure(bcs.U64.serialize(expiresAtMs).toBytes()),
      tx.object('0x6'),
    ],
  });

  // (d) Share the agent
  tx.moveCall({
    target: `${LIGHTHOUSE_PACKAGE_ID}::executor::share`,
    arguments: [agent],
  });

  // (e) Mint a DepositCap on the SAME BM handle and transfer it to the
  // backend executor. This bootstraps the deposit_with_cap path BEFORE the
  // BalanceManager is shared. Without this, web-onboarded users have
  // profile.deposit_cap_id === null and the autoDepositSweeper rejects
  // every inbound transfer with "profile missing deposit_cap_id".
  // Use the bm handle directly (same PTB) — DO NOT re-resolve via objectId
  // because BM is not yet a shared/owned object at this point in the PTB.
  const [depositCap] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::mint_deposit_cap`,
    arguments: [bm],
  });
  tx.transferObjects([depositCap], executorAddress);

  // (f) Share the BalanceManager (must come AFTER mint_deposit_cap so the
  // BM is still mutably owned by the PTB when we mint the cap).
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [`${DEEPBOOK_PACKAGE_ID}::balance_manager::BalanceManager`],
    arguments: [bm],
  });

  // ── Phase 4: Sponsor via Enoki (SENDER branch — explicit zkLogin address) ─
  // We use the sender branch instead of the jwt branch because the latter
  // returns bytes with sender=0x0, causing the chain to reject during
  // input-object validation. The sender branch sets the user's address
  // explicitly; Enoki's whitelist (allowedMoveCallTargets) is checked
  // server-side.
  //
  // executorAddress is passed as an extra allowed recipient because the
  // PTB now does transferObjects([depositCap], executorAddress). Without
  // this, Enoki rejects with "Address X is not allow-listed for receiving
  // transfers". Mirrors the DepositService.ts pattern (src/services/DepositService.ts:173).
  tx.setSender(userAddress);
  const sponsored = await sponsorForAddress(tx, userAddress, [executorAddress]);

  // ── Phase 5: Sign + execute as zkLogin user (uses ephemeral state) ───
  const exec = await executeSponsoredAsZkLoginUser({
    sponsored,
    state: args.zklState,
    jwt: args.jwt,
  });

  // ── Phase 6: Wait for finality, parse object changes, persist IDs ───
  await sleep(2000);
  type TxBlockShape = {
    objectChanges?: Array<{
      type?: string;
      objectId?: string;
      objectType?: string;
    }>;
  };
  // Use JSON-RPC for the tx-block fetch (consistent options shape).
  const rpcTx = suiRpc as unknown as {
    getTransactionBlock: (args: {
      digest: string;
      options?: { showObjectChanges?: boolean };
    }) => Promise<TxBlockShape>;
  };
  let txInfo: TxBlockShape | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      txInfo = await rpcTx.getTransactionBlock({
        digest: exec.digest,
        options: { showObjectChanges: true },
      });
      if (txInfo) break;
    } catch {
      await sleep(2000);
    }
  }
  if (!txInfo) throw new Error(`[setup-trading] setup tx ${exec.digest} not found after retries`);

  const created = (txInfo.objectChanges ?? []).filter(
    (c: { type?: string }) => c.type === 'created',
  );
  const bmObj = created.find((c: { objectType?: string }) =>
    c.objectType?.endsWith('::balance_manager::BalanceManager'),
  );
  const agentObj = created.find((c: { objectType?: string }) =>
    c.objectType?.endsWith('::executor::ExecutorAgent'),
  );
  if (!bmObj?.objectId || !agentObj?.objectId) {
    throw new Error(
      `[setup-trading] could not find BM + Agent in tx ${exec.digest} object_changes`,
    );
  }
  // DepositCap is minted in the same PTB and transferred to the executor.
  // Mirrors the parse pattern in src/services/DepositService.ts:213-218.
  const depositCapObj = created.find((c: { objectType?: string }) =>
    c.objectType?.endsWith('::balance_manager::DepositCap'),
  );
  if (!depositCapObj?.objectId) {
    // Non-fatal: BM+Agent already exist on chain; user can still trade. Surface
    // loudly so the autoDepositSweeper "profile missing deposit_cap_id" path
    // is debuggable.
    console.warn(
      `[setup-trading] DepositCap not found in tx ${exec.digest} object_changes — ` +
        `auto-sweep will fail until a /deposit is run manually for profile ${profile.id}`,
    );
  }

  await prismaQuery.traderProfile.update({
    where: { id: profile.id },
    data: {
      balance_manager_id: bmObj.objectId,
      executor_agent_id: agentObj.objectId,
      ...(depositCapObj?.objectId ? { deposit_cap_id: depositCapObj.objectId } : {}),
      executor_agent_cache_json: undefined,
      executor_agent_cache_at: null,
    },
  });

  return {
    skipped: false,
    dripDigest,
    setupDigest: exec.digest,
    balanceManagerId: bmObj.objectId,
    executorAgentId: agentObj.objectId,
    depositCapId: depositCapObj?.objectId ?? null,
    dripAmountMist: DRIP_AMOUNT_MIST,
  };
}
