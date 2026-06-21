/**
 * PredictService — per-user DeepBook Predict flow via sponsored zkLogin txs.
 *
 * Two entry points, mirroring DepositService's two-phase pattern:
 *
 *   1. setupPredictViaZkLogin
 *      Phase 1 (no predict_manager_id on profile). Runs after the user has
 *      sent DUSDC to their bound zkLogin address. We:
 *        a. Find a DUSDC coin at the user's address.
 *        b. PTB #1: predict::create_manager — creates + shares a PredictManager
 *           owned by the user. The Move function returns ID but the manager
 *           is `transfer::share_object`d internally, so its shared-object id
 *           cannot be referenced by another command in the same PTB.
 *        c. Parse objectChanges from PTB #1 to extract the new manager id.
 *        d. PTB #2: predict_manager::deposit<DUSDC>(manager, coin) — funds
 *           the freshly-created manager with the user's DUSDC. Uses the same
 *           jwt + zkLogin state (valid until maxEpoch).
 *        e. Persist predict_manager_id to TraderProfile.
 *
 *   2. mintPredictViaZkLogin
 *      Phase 2 (predict_manager_id present). Builds a single PTB that:
 *        a. market_key::new(oracle_id, expiry, strike, is_up) -> MarketKey
 *        b. predict::mint<DUSDC>(predict, manager, oracle, key, qty, clock)
 *      The PTB has NO Coin<DUSDC> arg — predict::mint debits the manager's
 *      internal balance directly. Manager must be pre-funded.
 *
 * Both phases:
 *   - Sender = user's zkLogin address.
 *   - Enoki sponsors gas (zero gas for user). Whitelist already includes
 *     predict::create_manager, predict_manager::deposit, predict::mint,
 *     market_key::new (see lib/enoki.ts + lib/predict.ts).
 *   - amount / market params come from OAuthNonce.action_meta (server-trusted).
 *
 * SECURITY:
 *   - profile.id is loaded fresh from DB inside this service; we never trust
 *     a client-supplied sui_address.
 *   - Same defense-in-depth as DepositService: Enoki sponsor branch enforces
 *     allowedAddresses=[user] + allowedMoveCallTargets whitelist.
 */

import { Transaction } from '@mysten/sui/transactions';

import {
  DUSDC_TYPE_TAG,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  SUI_RPC_URL,
} from '../config/main-config.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import {
  PREDICT_OBJECT_INITIAL_SHARED_VERSION,
  fetchInitialSharedVersion,
  fetchOracleExpiry,
} from '../lib/predict.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { suiRpc } from '../lib/sui.ts';
import {
  executeSponsoredAsZkLoginUser,
  type ZkLoginNonceState,
} from '../lib/zklogin.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits for a Sui transaction to be indexed and asserts it succeeded on-chain.
 *
 * Enoki's executeSponsoredTransaction only returns `{ digest }`. A Move abort
 * during execution is NOT surfaced as an HTTP error — the digest is valid but
 * `effects.status.status` is "failure". This helper throws for any non-success
 * outcome so callers can treat a returned digest as a proof of on-chain success.
 *
 * @param digest - The transaction digest returned by Enoki.
 * @param label  - Short prefix for log/error messages (e.g. "[predict-setup]").
 * @param fatal  - If true, RPC timeouts also throw; if false they are logged as warnings.
 */
async function assertTxSuccess(
  digest: string,
  label: string,
  fatal = false,
): Promise<void> {
  try {
    const txResult = (await suiRpc.waitForTransaction({
      digest,
      options: { showEffects: true },
      timeout: 60_000,
      pollInterval: 1_000,
    })) as { effects?: { status?: { status?: string; error?: string } } };
    const onChainStatus = txResult?.effects?.status?.status;
    if (onChainStatus !== 'success') {
      const onChainError = txResult?.effects?.status?.error ?? 'unknown on-chain error';
      throw new Error(`${label} on-chain execution failed for ${digest}: ${onChainError}`);
    }
  } catch (waitErr) {
    const msg = (waitErr as Error).message ?? '';
    if (msg.includes('on-chain execution failed')) throw waitErr;
    if (fatal) throw new Error(`${label} could not confirm on-chain status for ${digest}: ${msg}`);
    console.warn(`${label} could not confirm on-chain status for ${digest} (non-fatal): ${msg}`);
  }
}

// =============================================================================
// depositDusdcIntoExistingManager (internal helper)
// =============================================================================
//
// Standalone DUSDC deposit into a pre-existing PredictManager. Used by:
//   - setupPredictViaZkLogin's top-up branch (when profile.predict_manager_id
//     is set and amountRaw > 0 — the /topup Telegram command)
//
// Mirrors the deposit PTB inside setupPredictViaZkLogin (Phase 5) but skips
// the create_manager + objectChanges parsing because the manager already
// exists on chain. Looks up a DUSDC coin at the user's bound address with
// balance >= depositAmount, then runs predict_manager::deposit<DUSDC>.

async function depositDusdcIntoExistingManager(args: {
  userAddress: string;
  managerId: string;
  depositAmount: bigint;
  jwt: string;
  zklState: ZkLoginNonceState;
}): Promise<string> {
  if (args.depositAmount <= 0n) {
    throw new Error('[predict-topup] depositAmount must be positive');
  }

  // ── 1. Find a DUSDC coin at the user's bound address with sufficient balance.
  const ownedRpc = suiRpc as unknown as {
    getOwnedObjects: (params: {
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

  const dusdcStructType = `0x2::coin::Coin<${DUSDC_TYPE_TAG}>`;
  const resp = await ownedRpc.getOwnedObjects({
    owner: args.userAddress,
    filter: { StructType: dusdcStructType },
    options: { showContent: true },
  });

  const candidates = (resp.data ?? [])
    .filter((c) => {
      const bal = c.data?.content?.fields?.balance;
      return (
        !!c.data?.objectId &&
        !!c.data?.version &&
        !!c.data?.digest &&
        bal != null &&
        BigInt(bal) >= args.depositAmount
      );
    })
    .sort((a, b) => {
      const ba = BigInt(b.data?.content?.fields?.balance ?? '0');
      const aa = BigInt(a.data?.content?.fields?.balance ?? '0');
      return ba > aa ? 1 : ba < aa ? -1 : 0;
    });

  const coinEntry = candidates[0]?.data;
  if (!coinEntry?.objectId || !coinEntry.version || !coinEntry.digest) {
    throw new Error(
      `[predict-topup] No DUSDC coin with balance >= ${args.depositAmount.toString()} raw units found at ${args.userAddress}. ` +
        `Send more DUSDC to this address from your wallet and try again.`,
    );
  }

  // ── 2. Resolve the existing manager's initialSharedVersion on-chain.
  const mgrInitialVersion = await fetchInitialSharedVersion(
    SUI_RPC_URL,
    args.managerId,
  );
  if (mgrInitialVersion === null) {
    throw new Error(
      `[predict-topup] could not resolve initialSharedVersion for manager ${args.managerId}`,
    );
  }

  // ── 3. Build + execute the deposit PTB (sponsored, signed by zkLogin user).
  const depositTx = new Transaction();
  depositTx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    typeArguments: [DUSDC_TYPE_TAG],
    arguments: [
      depositTx.sharedObjectRef({
        objectId: args.managerId,
        initialSharedVersion: mgrInitialVersion,
        mutable: true,
      }),
      depositTx.objectRef({
        objectId: coinEntry.objectId,
        version: coinEntry.version,
        digest: coinEntry.digest,
      }),
    ],
  });
  depositTx.setSender(args.userAddress);

  const sponsored = await sponsorForAddress(depositTx, args.userAddress);
  const exec = await executeSponsoredAsZkLoginUser({
    sponsored,
    state: args.zklState,
    jwt: args.jwt,
  });

  await assertTxSuccess(exec.digest, '[predict-topup]', true);

  console.log(
    `[predict-topup] OK manager=${args.managerId.slice(0, 10)}… ` +
      `amount=${args.depositAmount.toString()} digest=${exec.digest.slice(0, 12)}…`,
  );

  return exec.digest;
}

// =============================================================================
// setupPredictViaZkLogin
// =============================================================================

export interface PredictSetupArgs {
  traderProfileId: string;
  jwt: string;
  zklState: ZkLoginNonceState;
  /// DUSDC raw units to deposit (DUSDC has 6 decimals — 50 DUSDC = 50_000_000).
  /// Optional: when undefined or 0n the deposit phase is skipped and only the
  /// PredictManager is created (web onboarding flow — user funds separately).
  amountRaw?: bigint;
}

export interface PredictSetupResult {
  digest: string;
  predictManagerId: string;
}

/**
 * Bootstrap a user's Predict account: create PredictManager + deposit DUSDC.
 *
 * Returns the deposit-tx digest (the user-visible "this funded my account"
 * transaction) and the persisted predict_manager_id.
 */
export async function setupPredictViaZkLogin(
  args: PredictSetupArgs,
): Promise<PredictSetupResult> {
  if (!PREDICT_PACKAGE_ID) {
    throw new Error('[predict-setup] PREDICT_PACKAGE_ID missing in env');
  }

  const depositAmount = args.amountRaw ?? 0n;
  if (depositAmount < 0n) {
    throw new Error('[predict-setup] amountRaw must be non-negative');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.traderProfileId },
  });
  if (!profile) {
    throw new Error(
      `[predict-setup] TraderProfile ${args.traderProfileId} not found`,
    );
  }

  const userAddress = profile.sui_address;

  // Idempotency / top-up branch: if the manager already exists, we can still
  // be asked to deposit more DUSDC (the /topup Telegram command, or a repeat
  // setup attempt after a partial failure). When amountRaw is 0 there is
  // nothing to do; return early. When amountRaw > 0 we skip create_manager
  // but still run the deposit PTB against the existing PredictManager.
  if (profile.predict_manager_id) {
    if (depositAmount === 0n) {
      console.log(
        `[predict-setup] already set up for profile=${profile.id} manager=${profile.predict_manager_id.slice(0, 10)}… and no top-up requested — returning early`,
      );
      return { digest: 'already-set-up', predictManagerId: profile.predict_manager_id };
    }

    console.log(
      `[predict-setup] existing manager ${profile.predict_manager_id.slice(0, 10)}… top-up requested for profile=${profile.id} amountRaw=${depositAmount.toString()}`,
    );
    const topUpDigest = await depositDusdcIntoExistingManager({
      userAddress,
      managerId: profile.predict_manager_id,
      depositAmount,
      jwt: args.jwt,
      zklState: args.zklState,
    });
    return { digest: topUpDigest, predictManagerId: profile.predict_manager_id };
  }

  // ── Phase 1 (conditional): Find a DUSDC coin for the initial deposit ──────
  // Skipped when depositAmount is 0n (web onboarding — user funds later via
  // the predict page's deposit flow).
  let coin: { coinObjectId: string; version: string; digest: string } | null = null;
  if (depositAmount > 0n) {
    const ownedRpc = suiRpc as unknown as {
      getOwnedObjects: (params: {
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

    const dusdcStructType = `0x2::coin::Coin<${DUSDC_TYPE_TAG}>`;
    const resp = await ownedRpc.getOwnedObjects({
      owner: userAddress,
      filter: { StructType: dusdcStructType },
      options: { showContent: true },
    });

    const candidates = (resp.data ?? [])
      .filter((c) => {
        const bal = c.data?.content?.fields?.balance;
        return (
          !!c.data?.objectId &&
          !!c.data?.version &&
          !!c.data?.digest &&
          bal != null &&
          BigInt(bal) >= depositAmount
        );
      })
      .sort((a, b) => {
        const ba = BigInt(b.data?.content?.fields?.balance ?? '0');
        const aa = BigInt(a.data?.content?.fields?.balance ?? '0');
        return ba > aa ? 1 : ba < aa ? -1 : 0;
      });

    const coinEntry = candidates[0]?.data;
    if (!coinEntry?.objectId || !coinEntry.version || !coinEntry.digest) {
      throw new Error(
        `[predict-setup] No DUSDC coin with balance >= ${depositAmount.toString()} raw units found at ${userAddress}. ` +
          `Send DUSDC to this address from your wallet first.`,
      );
    }
    coin = {
      coinObjectId: coinEntry.objectId,
      version: coinEntry.version,
      digest: coinEntry.digest,
    };
  }

  // ── Phase 2: PTB #1 — predict::create_manager ────────────────────────────
  // The Move function returns ID by value but internally calls
  // transfer::share_object on the new PredictManager. The shared-object id is
  // NOT available as a usable PTB result in the same block; we need a second
  // PTB after observing objectChanges.
  const createTx = new Transaction();
  createTx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::create_manager`,
    arguments: [],
  });
  createTx.setSender(userAddress);

  const sponsoredCreate = await sponsorForAddress(createTx, userAddress);
  const createExec = await executeSponsoredAsZkLoginUser({
    sponsored: sponsoredCreate,
    state: args.zklState,
    jwt: args.jwt,
  });

  // Fail fast: if create_manager aborted on-chain the polling loop below would
  // wait 16 s then throw a confusing "no PredictManager object" error.
  await assertTxSuccess(createExec.digest, '[predict-setup/create]', true);

  // ── Phase 3: Parse objectChanges from PTB #1 to extract manager id ──────
  type TxBlockShape = {
    objectChanges?: Array<{
      type?: string;
      objectId?: string;
      objectType?: string;
      owner?: unknown;
    }>;
  };
  const rpcTx = suiRpc as unknown as {
    getTransactionBlock: (params: {
      digest: string;
      options?: { showObjectChanges?: boolean };
    }) => Promise<TxBlockShape>;
  };

  let txInfo: TxBlockShape | null = null;
  for (let i = 0; i < 8; i++) {
    try {
      await sleep(2000);
      txInfo = await rpcTx.getTransactionBlock({
        digest: createExec.digest,
        options: { showObjectChanges: true },
      });
      if (txInfo?.objectChanges?.length) break;
    } catch {
      // keep polling
    }
  }

  const created = (txInfo?.objectChanges ?? []).filter(
    (c) => c.type === 'created',
  );
  const managerObj = created.find((c) =>
    c.objectType?.includes('::predict_manager::PredictManager'),
  );
  if (!managerObj?.objectId) {
    throw new Error(
      `[predict-setup] create_manager tx ${createExec.digest} did not produce a PredictManager object`,
    );
  }
  const predictManagerId = managerObj.objectId;

  // ── Phase 4: Resolve the new manager's initialSharedVersion on-chain ────
  let mgrInitialVersion: number | null = null;
  for (let i = 0; i < 6; i++) {
    mgrInitialVersion = await fetchInitialSharedVersion(
      SUI_RPC_URL,
      predictManagerId,
    );
    if (mgrInitialVersion !== null) break;
    await sleep(1000);
  }
  if (mgrInitialVersion === null) {
    throw new Error(
      `[predict-setup] could not resolve initialSharedVersion for new manager ${predictManagerId}`,
    );
  }

  // ── Phase 5 (conditional): PTB #2 — predict_manager::deposit<DUSDC>(manager, coin) ──
  // Skipped when no DUSDC coin was located (depositAmount = 0n / web flow).
  // The caller's result.digest will be the create_manager tx in this case.
  let finalDigest = createExec.digest;
  if (coin !== null) {
    const depositTx = new Transaction();
    depositTx.moveCall({
      target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
      typeArguments: [DUSDC_TYPE_TAG],
      arguments: [
        depositTx.sharedObjectRef({
          objectId: predictManagerId,
          initialSharedVersion: mgrInitialVersion,
          mutable: true,
        }),
        depositTx.objectRef({
          objectId: coin.coinObjectId,
          version: coin.version,
          digest: coin.digest,
        }),
      ],
    });
    depositTx.setSender(userAddress);

    const sponsoredDeposit = await sponsorForAddress(depositTx, userAddress);
    const depositExec = await executeSponsoredAsZkLoginUser({
      sponsored: sponsoredDeposit,
      state: args.zklState,
      jwt: args.jwt,
    });

    // Verify deposit succeeded on-chain before saving the manager id. If the
    // deposit aborts (e.g. coin was consumed in a concurrent tx) we throw here
    // so the caller knows the manager is unfunded — they can retry the setup
    // which will detect the existing manager id and skip creation.
    await assertTxSuccess(depositExec.digest, '[predict-setup/deposit]', true);
    finalDigest = depositExec.digest;
  }

  // ── Phase 6: Persist predict_manager_id ─────────────────────────────────
  await prismaQuery.traderProfile.update({
    where: { id: profile.id },
    data: { predict_manager_id: predictManagerId },
  });

  console.log(
    `[predict-setup] OK profile=${profile.id} manager=${predictManagerId.slice(0, 10)}… ` +
      `createDigest=${createExec.digest.slice(0, 12)}… ` +
      (coin !== null ? `depositDigest=${finalDigest.slice(0, 12)}…` : 'deposit=skipped'),
  );

  return {
    digest: finalDigest,
    predictManagerId,
  };
}

// =============================================================================
// mintPredictViaZkLogin
// =============================================================================

export interface PredictMintArgs {
  traderProfileId: string;
  jwt: string;
  zklState: ZkLoginNonceState;
  predictObjectId: string;
  oracleObjectId: string;
  oracleInitialSharedVersion: number;
  expiryMs: bigint;
  strike: bigint;
  isUp: boolean;
  /// DUSDC raw units to wager. Debited from the manager's internal balance.
  quantity: bigint;
}

export interface PredictMintResult {
  digest: string;
}

/**
 * Place a single binary prediction via predict::mint. The user's PredictManager
 * is the funding source — no Coin arg in this PTB.
 */
export async function mintPredictViaZkLogin(
  args: PredictMintArgs,
): Promise<PredictMintResult> {
  if (!PREDICT_PACKAGE_ID) {
    throw new Error('[predict-mint] PREDICT_PACKAGE_ID missing in env');
  }
  if (args.quantity <= 0n) {
    throw new Error('[predict-mint] quantity must be positive');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.traderProfileId },
  });
  if (!profile) {
    throw new Error(
      `[predict-mint] TraderProfile ${args.traderProfileId} not found`,
    );
  }
  if (!profile.predict_manager_id) {
    throw new Error(
      '[predict-mint] TraderProfile has no predict_manager_id; run /predict setup first',
    );
  }

  // Defense in depth: server-side check that the caller-supplied predict
  // object matches the configured one. The action_meta is filled in by the
  // bot, but we cross-check against config so a malicious nonce row can't
  // route txs to an attacker-controlled Predict shared object.
  if (PREDICT_OBJECT_ID && args.predictObjectId !== PREDICT_OBJECT_ID) {
    throw new Error(
      `[predict-mint] predictObjectId mismatch (got ${args.predictObjectId}, expected ${PREDICT_OBJECT_ID})`,
    );
  }

  const userAddress = profile.sui_address;
  const managerId = profile.predict_manager_id;

  // Resolve the user's PredictManager initialSharedVersion on-chain.
  const mgrInitialVersion = await fetchInitialSharedVersion(
    SUI_RPC_URL,
    managerId,
  );
  if (mgrInitialVersion === null) {
    throw new Error(
      `[predict-mint] could not resolve initialSharedVersion for manager ${managerId}`,
    );
  }

  // ── Build the mint PTB ──────────────────────────────────────────────────
  const tx = new Transaction();

  const [marketKey] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::new`,
    arguments: [
      tx.pure.id(args.oracleObjectId),
      tx.pure.u64(args.expiryMs),
      tx.pure.u64(args.strike),
      tx.pure.bool(args.isUp),
    ],
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::mint`,
    typeArguments: [DUSDC_TYPE_TAG],
    arguments: [
      tx.sharedObjectRef({
        objectId: args.predictObjectId,
        initialSharedVersion: PREDICT_OBJECT_INITIAL_SHARED_VERSION,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: managerId,
        initialSharedVersion: mgrInitialVersion,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: args.oracleObjectId,
        initialSharedVersion: args.oracleInitialSharedVersion,
        mutable: false,
      }),
      marketKey,
      tx.pure.u64(args.quantity),
      tx.object('0x6'),
    ],
  });

  tx.setSender(userAddress);

  const sponsored = await sponsorForAddress(tx, userAddress);
  const exec = await executeSponsoredAsZkLoginUser({
    sponsored,
    state: args.zklState,
    jwt: args.jwt,
  });

  // Verify on-chain execution succeeded before writing the HedgePosition row.
  // Enoki returns a digest even for Move aborts — without this guard a
  // phantom position would be recorded that can never be redeemed.
  // RPC timeouts are treated as non-fatal: the position may have been created
  // and we prefer to record it (the claim flow has its own guard).
  await assertTxSuccess(exec.digest, '[predict-mint]', false);

  // ── Best-effort: record the open position in HedgePosition ──────────────
  try {
    await prismaQuery.hedgePosition.create({
      data: {
        trader_profile_id: profile.id,
        oracle_id: args.oracleObjectId,
        predict_id: args.predictObjectId,
        strike: args.strike,
        is_up: args.isUp,
        quantity: args.quantity,
        expiry_ms: args.expiryMs,
        cost: 0n,
        status: 'open',
        tx_digest: exec.digest,
      },
    });
  } catch (dbErr) {
    console.warn(
      `[predict-mint] hedge_position insert failed (non-fatal): ${(dbErr as Error).message}`,
    );
  }

  console.log(
    `[predict-mint] OK profile=${profile.id} digest=${exec.digest.slice(0, 12)}… ` +
      `dir=${args.isUp ? 'UP' : 'DOWN'} qty=${args.quantity.toString()}`,
  );

  return { digest: exec.digest };
}

// =============================================================================
// redeemPredictViaZkLogin
// =============================================================================

/**
 * Claim winnings on a settled MarketKey via predict::redeem<Quote>. Mirrors
 * mintPredictViaZkLogin (same arg shape, same manager-funded model: no Coin
 * input). The Move call credits the user's PredictManager with the payout
 * proportional to `quantity`. On-chain enforces that the market has settled
 * (oracle.settlement_price != null) and that the caller's MarketKey side
 * matches the winning outcome — server-side we just rebuild the PTB the
 * settlement worker already pre-classified as winning.
 *
 * After success we mark the HedgePosition `redeemed` so the next worker tick
 * won't surface it again. Failure surfaces to the OAuth callback page so the
 * user sees the error and can retry /predict.
 */
export async function redeemPredictViaZkLogin(
  args: PredictMintArgs,
): Promise<PredictMintResult> {
  if (!PREDICT_PACKAGE_ID) {
    throw new Error('[predict-redeem] PREDICT_PACKAGE_ID missing in env');
  }
  if (args.quantity <= 0n) {
    throw new Error('[predict-redeem] quantity must be positive');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.traderProfileId },
  });
  if (!profile) {
    throw new Error(
      `[predict-redeem] TraderProfile ${args.traderProfileId} not found`,
    );
  }
  if (!profile.predict_manager_id) {
    throw new Error(
      '[predict-redeem] TraderProfile has no predict_manager_id; nothing to redeem',
    );
  }

  // Defense in depth: cross-check predictObjectId against config so a stale
  // or malicious nonce row can't route the redeem to an attacker-controlled
  // Predict shared object.
  if (PREDICT_OBJECT_ID && args.predictObjectId !== PREDICT_OBJECT_ID) {
    throw new Error(
      `[predict-redeem] predictObjectId mismatch (got ${args.predictObjectId}, expected ${PREDICT_OBJECT_ID})`,
    );
  }

  const userAddress = profile.sui_address;
  const managerId = profile.predict_manager_id;

  const mgrInitialVersion = await fetchInitialSharedVersion(
    SUI_RPC_URL,
    managerId,
  );
  if (mgrInitialVersion === null) {
    throw new Error(
      `[predict-redeem] could not resolve initialSharedVersion for manager ${managerId}`,
    );
  }

  // Resolve oracle ISV on-demand. When `args.oracleInitialSharedVersion` is 0
  // (e.g. from the /positions command or an old claim link), fetch it fresh so
  // the PTB shared-object reference is correct.
  let oracleIsv = args.oracleInitialSharedVersion;
  if (!oracleIsv) {
    const fetched = await fetchInitialSharedVersion(SUI_RPC_URL, args.oracleObjectId);
    if (fetched === null) {
      throw new Error(
        `[predict-redeem] could not resolve initialSharedVersion for oracle ${args.oracleObjectId}`,
      );
    }
    oracleIsv = fetched;
  }

  // Resolve expiryMs on-demand. Old HedgePosition rows created before the
  // `expiry_ms` schema column was added will have expiry_ms=null in the DB,
  // which the /positions command encodes as '0' in the claim link's action_meta.
  // We detect the sentinel (0n) here and fetch the oracle's on-chain `expiry`
  // field to reconstruct the exact value that was used in market_key::new
  // at mint time. Without this, the MarketKey hash won't match the on-chain
  // position and predict_manager::decrease_position aborts with EInsufficientPosition.
  let expiryMs = args.expiryMs;
  if (!expiryMs) {
    const fetched = await fetchOracleExpiry(SUI_RPC_URL, args.oracleObjectId);
    if (fetched === null) {
      throw new Error(
        `[predict-redeem] could not resolve expiryMs from oracle ${args.oracleObjectId}`,
      );
    }
    expiryMs = fetched;
    console.log(
      `[predict-redeem] resolved expiryMs lazily from oracle: ${expiryMs.toString()} for ${args.oracleObjectId}`,
    );
  }

  // ── Build the redeem PTB ───────────────────────────────────────────────
  // Same layout as mint: build a fresh MarketKey via market_key::new and pass
  // it by value to predict::redeem<Quote>. No Coin input — payout lands in
  // the user's PredictManager internal balance.
  const tx = new Transaction();

  const [marketKey] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::new`,
    arguments: [
      tx.pure.id(args.oracleObjectId),
      tx.pure.u64(expiryMs),
      tx.pure.u64(args.strike),
      tx.pure.bool(args.isUp),
    ],
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::redeem`,
    typeArguments: [DUSDC_TYPE_TAG],
    arguments: [
      tx.sharedObjectRef({
        objectId: args.predictObjectId,
        initialSharedVersion: PREDICT_OBJECT_INITIAL_SHARED_VERSION,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: managerId,
        initialSharedVersion: mgrInitialVersion,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: args.oracleObjectId,
        initialSharedVersion: oracleIsv,
        mutable: false,
      }),
      marketKey,
      tx.pure.u64(args.quantity),
      tx.object('0x6'),
    ],
  });

  tx.setSender(userAddress);

  // Diagnostic log so server logs capture the exact MarketKey args for
  // every redeem attempt. If the next claim fails, compare these values
  // against what was used during the original predict::mint call.
  console.log(
    `[predict-redeem] PTB args: oracle=${args.oracleObjectId.slice(0, 10)}… ` +
      `expiryMs=${expiryMs.toString()} strike=${args.strike.toString()} ` +
      `isUp=${args.isUp} qty=${args.quantity.toString()} ` +
      `oracleIsv=${oracleIsv} manager=${managerId.slice(0, 10)}…`,
  );

  let sponsored: { digest: string; bytes: string };
  try {
    sponsored = await sponsorForAddress(tx, userAddress);
  } catch (sponsorErr) {
    // sponsorForAddress runs Enoki's dry-run. If the position doesn't exist
    // in the PredictManager (because the original predict::mint failed
    // on-chain after a successful dry-run), the dry-run aborts here with
    // EInsufficientPosition in predict_manager.
    const msg = (sponsorErr as Error & { errors?: { message?: string }[] })
      .errors?.[0]?.message ?? (sponsorErr as Error).message ?? String(sponsorErr);
    if (msg.includes('predict_manager') || msg.includes('EInsufficientPosition')) {
      throw new Error(
        'No claimable position found on-chain for this market. ' +
        'This can happen if the original prediction was placed on an oracle that settled ' +
        'between the dry-run and on-chain execution. Please use /predict to place a new prediction.',
      );
    }
    throw sponsorErr;
  }

  const exec = await executeSponsoredAsZkLoginUser({
    sponsored,
    state: args.zklState,
    jwt: args.jwt,
  });

  // Verify the redeem succeeded on-chain before updating the DB. Without this
  // a network glitch or unexpected Move abort could flip the row to 'redeemed'
  // while the on-chain position is still live — preventing a future retry.
  await assertTxSuccess(exec.digest, '[predict-redeem]', true);

  // ── Best-effort: mark all settled positions for this market as redeemed ─
  // We don't know which HedgePosition row exactly matches the redeemed claim
  // (the user could have multiple settled positions on the same oracle), so we
  // scope by (trader, oracle, predict, strike, is_up, status=settled). For v1
  // a single position per (trader, market, side) is the common case.
  try {
    await prismaQuery.hedgePosition.updateMany({
      where: {
        trader_profile_id: profile.id,
        oracle_id: args.oracleObjectId,
        predict_id: args.predictObjectId,
        strike: args.strike,
        is_up: args.isUp,
        status: 'settled',
      },
      data: { status: 'redeemed' },
    });
  } catch (dbErr) {
    console.warn(
      `[predict-redeem] hedge_position status flip failed (non-fatal): ${(dbErr as Error).message}`,
    );
  }

  console.log(
    `[predict-redeem] OK profile=${profile.id} digest=${exec.digest.slice(0, 12)}… ` +
      `dir=${args.isUp ? 'UP' : 'DOWN'} qty=${args.quantity.toString()}`,
  );

  return { digest: exec.digest };
}
