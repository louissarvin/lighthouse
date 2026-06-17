/**
 * DepositService — deposit SUI from a user's bound zkLogin address into their
 * DeepBook BalanceManager via a sponsored zkLogin transaction.
 *
 * Flow:
 *   1. User has previously sent SUI from their external wallet (Slush) to
 *      their bound `profile.sui_address`.
 *   2. After the OAuth callback completes with `action=deposit`, the route
 *      invokes this service with a fresh JWT + ephemeral zkLogin state.
 *   3. We locate a SUI coin at `sui_address` with balance >= amountMist.
 *   4. We build a PTB sent by the user:
 *        a. balance_manager::deposit<SUI>(bm, coin)
 *        b. (if profile.deposit_cap_id missing) mint a DepositCap and transfer
 *           it to the executor. This bootstraps the backend's deposit_with_cap
 *           path for future /deposit calls.
 *   5. Sponsor via Enoki, execute as the zkLogin user. Zero gas for the user.
 *   6. Wait for finality, parse object changes, persist deposit_cap_id if minted.
 *
 * SECURITY:
 *   - Sender is set explicitly to the user's bound zkLogin address.
 *   - Enoki sponsor branch enforces `allowedAddresses=[user]` and
 *     `allowedMoveCallTargets` (whitelisted in enoki.ts).
 *   - We never accept the amount/profile from a client; both come from the
 *     OAuthNonce.action_meta the bot set when initiating the flow.
 */

import { Transaction } from '@mysten/sui/transactions';

import { DEEPBOOK_PACKAGE_ID } from '../config/main-config.ts';
import { getExecutorKeypair } from '../lib/keypairs.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { suiRpc } from '../lib/sui.ts';
import {
  executeSponsoredAsZkLoginUser,
  type ZkLoginNonceState,
} from '../lib/zklogin.ts';

const SUI_TYPE_TAG =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface DepositResult {
  digest: string;
}

/**
 * Deposit SUI from the user's bound zkLogin address into their BalanceManager.
 */
export async function depositViaZkLogin(args: {
  traderProfileId: string;
  jwt: string;
  zklState: ZkLoginNonceState;
  amountMist: bigint;
}): Promise<DepositResult> {
  if (!DEEPBOOK_PACKAGE_ID) {
    throw new Error('[deposit] DEEPBOOK_PACKAGE_ID missing in env');
  }
  if (args.amountMist <= 0n) {
    throw new Error('[deposit] amountMist must be positive');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.traderProfileId },
  });
  if (!profile) {
    throw new Error(`[deposit] TraderProfile ${args.traderProfileId} not found`);
  }
  if (!profile.balance_manager_id) {
    throw new Error(
      '[deposit] TraderProfile has no balance_manager_id; complete onboarding first',
    );
  }

  const userAddress = profile.sui_address;
  const bmId = profile.balance_manager_id;
  const needsDepositCap = !profile.deposit_cap_id;

  // ── Phase 1: Find a SUI coin at the user's address with sufficient balance ─
  // Use getOwnedObjects with StructType filter — same pattern as SetupTrading.ts.
  // SuiJsonRpcClient does not expose getCoins as a typed method.
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

  const resp = await ownedRpc.getOwnedObjects({
    owner: userAddress,
    filter: { StructType: '0x2::coin::Coin<0x2::sui::SUI>' },
    options: { showContent: true },
  });

  // Pick the LARGEST coin with balance >= amountMist (avoids splitting tiny coins).
  const candidates = (resp.data ?? [])
    .filter((c) => {
      const bal = c.data?.content?.fields?.balance;
      return (
        !!c.data?.objectId &&
        !!c.data?.version &&
        !!c.data?.digest &&
        bal != null &&
        BigInt(bal) >= args.amountMist
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
      `[deposit] No SUI coin with balance >= ${args.amountMist.toString()} MIST found at ${userAddress}. ` +
        `Send SUI to this address from your wallet first.`,
    );
  }
  // Alias to match the rest of the function's variable name.
  const coin = {
    coinObjectId: coinEntry.objectId,
    version: coinEntry.version,
    digest: coinEntry.digest,
  };

  // ── Phase 2: Build the deposit PTB as the user ──────────────────────────
  const tx = new Transaction();

  tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
    typeArguments: [SUI_TYPE_TAG],
    arguments: [
      tx.object(bmId),
      tx.objectRef({
        objectId: coin.coinObjectId,
        version: coin.version,
        digest: coin.digest,
      }),
    ],
  });

  // If we haven't yet captured a DepositCap for the backend executor, mint one
  // in the SAME PTB and transfer it to the executor address. This lets future
  // /deposit calls use deposit_with_cap (backend-signed, no JWT needed).
  const executorAddress = getExecutorKeypair().toSuiAddress();
  if (needsDepositCap) {
    const [depositCap] = tx.moveCall({
      target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::mint_deposit_cap`,
      arguments: [tx.object(bmId)],
    });
    tx.transferObjects([depositCap], executorAddress);
  }

  tx.setSender(userAddress);

  // ── Phase 3: Sponsor via Enoki (sender branch) ──────────────────────────
  // Pass executorAddress as an extra allowed address so Enoki permits the
  // transferObjects([depositCap], executorAddress) call when minting a DepositCap.
  // Without this, Enoki returns 400 "Address X is not allow-listed for receiving transfers".
  const sponsored = await sponsorForAddress(tx, userAddress, [executorAddress]);

  // ── Phase 4: Sign + execute as zkLogin user ─────────────────────────────
  const exec = await executeSponsoredAsZkLoginUser({
    sponsored,
    state: args.zklState,
    jwt: args.jwt,
  });

  // ── Phase 5: Wait for finality; if we minted a DepositCap, persist it ───
  if (needsDepositCap) {
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
    for (let i = 0; i < 6; i++) {
      try {
        await sleep(2000);
        txInfo = await rpcTx.getTransactionBlock({
          digest: exec.digest,
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
    const depositCapObj = created.find((c) =>
      c.objectType?.endsWith('::balance_manager::DepositCap'),
    );
    if (depositCapObj?.objectId) {
      await prismaQuery.traderProfile.update({
        where: { id: profile.id },
        data: { deposit_cap_id: depositCapObj.objectId },
      });
      console.log(
        `[deposit] minted + persisted DepositCap ${depositCapObj.objectId.slice(0, 10)}… for profile ${profile.id}`,
      );
    } else {
      console.warn(
        `[deposit] needsDepositCap=true but no DepositCap object found in tx ${exec.digest}`,
      );
    }
  }

  console.log(`[deposit] success digest=${exec.digest} profile=${profile.id} amount=${args.amountMist.toString()}`);
  return { digest: exec.digest };
}

/**
 * Quick check: is there a SUI coin at `address` with balance >= `minMist`?
 * Use before showing the deposit button to give the user early feedback.
 */
export async function hasSufficientSuiBalance(
  address: string,
  minMist: bigint,
): Promise<boolean> {
  try {
    const ownedRpc = suiRpc as unknown as {
      getOwnedObjects: (args: {
        owner: string;
        filter?: { StructType?: string };
        options?: { showContent?: boolean };
      }) => Promise<{
        data?: Array<{
          data?: { content?: { fields?: { balance?: string } } };
        }>;
      }>;
    };
    const resp = await ownedRpc.getOwnedObjects({
      owner: address,
      filter: { StructType: '0x2::coin::Coin<0x2::sui::SUI>' },
      options: { showContent: true },
    });
    return (resp.data ?? []).some((c) => {
      const bal = c.data?.content?.fields?.balance;
      return bal != null && BigInt(bal) >= minMist;
    });
  } catch {
    return false;
  }
}
