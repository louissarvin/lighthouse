/**
 * Enoki sponsored transactions (testnet).
 *
 * Source: https://docs.enoki.mystenlabs.com/ts-sdk/examples
 *
 * Two branches of `createSponsoredTransaction`:
 *   - zkLogin: { network?, transactionKindBytes, jwt }
 *     Sender derived from JWT. `allowedAddresses` / `allowedMoveCallTargets`
 *     NOT accepted here.
 *   - Sponsor (raw sender, including zkLogin-derived addresses):
 *     { network?, transactionKindBytes, sender, allowedAddresses?,
 *       allowedMoveCallTargets? }
 *
 * SECURITY:
 *   - On the sponsor branch ALWAYS pass both `allowedMoveCallTargets` and
 *     `allowedAddresses` whitelists. Anything sponsored without these is a
 *     full gas-grief vector.
 *   - Build `transactionKindBytes` via `tx.build({ client, onlyTransactionKind: true })`
 *     then base64-encode.
 *   - `executeSponsoredTransaction` is OBJECT FORM: `{ digest, signature }`.
 */

import { EnokiClient } from '@mysten/enoki';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';

import {
  ENOKI_PRIVATE_KEY,
  LIGHTHOUSE_PACKAGE_ID,
  MEMWAL_PACKAGE_ID,
  SUI_NETWORK,
} from '../config/main-config.ts';
import { getPredictAllowedMoveCallTargets } from './predict.ts';
import { suiGrpc } from './sui.ts';

let _enoki: EnokiClient | null = null;

export function getEnoki(): EnokiClient {
  if (!_enoki) {
    if (!ENOKI_PRIVATE_KEY) {
      throw new Error('[enoki] ENOKI_PRIVATE_KEY is not set');
    }
    _enoki = new EnokiClient({ apiKey: ENOKI_PRIVATE_KEY });
  }
  return _enoki;
}

/**
 * Whitelist of Move call targets Lighthouse will sponsor on the sponsor branch.
 * Update when adding new entry functions. Includes Lighthouse + DeepBook
 * Predict (when configured) + DeepBook setup calls (BalanceManager creation +
 * deposit) used during the auto-setup-trading flow.
 */
export function getAllowedMoveCallTargets(): string[] {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[enoki] LIGHTHOUSE_PACKAGE_ID is not set — cannot construct whitelist');
  }
  const lighthouseTargets = [
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::create`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::share`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::update_blob`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::grant_audit`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::revoke_audit`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::grant_copy_trader`,
    `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::revoke_copy_trader`,
    `${LIGHTHOUSE_PACKAGE_ID}::executor::create_agent`,
    `${LIGHTHOUSE_PACKAGE_ID}::executor::share`,
    `${LIGHTHOUSE_PACKAGE_ID}::executor::place_limit_under_budget`,
    `${LIGHTHOUSE_PACKAGE_ID}::executor::revoke`,
    `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
    `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
  ];
  // DeepBook setup calls needed for the auto-setup-trading flow that runs
  // during the OAuth callback. Without these, Enoki rejects the sponsored
  // tx. See `backend/src/services/SetupTrading.ts`.
  const deepbookSetupTargets: string[] = [];
  const deepbookPkg = process.env.DEEPBOOK_PACKAGE_ID;
  if (deepbookPkg) {
    deepbookSetupTargets.push(
      `${deepbookPkg}::balance_manager::new`,
      `${deepbookPkg}::balance_manager::deposit`,
      `${deepbookPkg}::balance_manager::mint_deposit_cap`,
    );
  }
  // Core Sui targets used during setup. public_share_object is needed to
  // make the BalanceManager + ExecutorAgent shared in the same atomic PTB.
  const coreSuiTargets = [
    `0x0000000000000000000000000000000000000000000000000000000000000002::transfer::public_share_object`,
  ];
  // MemWal bootstrap: create_account + add_delegate_key are called in the
  // two-step MemWal bootstrap flow (MemWalBootstrap.ts) via sponsorForAddress.
  // Without these targets in the allowlist, Enoki rejects the sponsored txs.
  const memwalTargets: string[] = [];
  if (MEMWAL_PACKAGE_ID) {
    memwalTargets.push(
      `${MEMWAL_PACKAGE_ID}::account::create_account`,
      `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
    );
  }
  return [
    ...lighthouseTargets,
    ...deepbookSetupTargets,
    ...coreSuiTargets,
    ...memwalTargets,
    ...getPredictAllowedMoveCallTargets(),
  ];
}

export interface SponsoredTxResult {
  digest: string;
  /// Sponsored tx bytes — user signs these client-side.
  bytes: string;
}

/**
 * Build a sponsored transaction. `tx` must be a Transaction that ONLY calls
 * whitelisted Move targets and ONLY affects the user's owned objects.
 *
 * @param tx                   Pre-built Transaction (NOT yet signed).
 * @param sender               User's Sui address.
 * @param extraAllowedAddresses Additional addresses Enoki allows receiving transfers
 *                             (e.g. executor address when minting a DepositCap).
 *                             Sender is always included automatically.
 */
export async function sponsorForAddress(
  tx: Transaction,
  sender: string,
  extraAllowedAddresses: string[] = [],
): Promise<SponsoredTxResult> {
  const enoki = getEnoki();

  // CRITICAL field name: `transactionKindBytes`, not `transactionBlockBytes`.
  const txKindBytes = await tx.build({
    client: suiGrpc as never,
    onlyTransactionKind: true,
  });

  // Deduplicate addresses — Enoki rejects duplicates.
  const allowedAddresses = [...new Set([sender, ...extraAllowedAddresses])];

  const sponsored = await enoki.createSponsoredTransaction({
    network: SUI_NETWORK as 'mainnet' | 'testnet',
    transactionKindBytes: toBase64(txKindBytes),
    sender,
    allowedMoveCallTargets: getAllowedMoveCallTargets(),
    allowedAddresses,
  });

  return {
    digest: sponsored.digest,
    bytes: sponsored.bytes,
  };
}

/**
 * Execute a sponsored transaction after the user signs.
 * `signature` is the user's signature over `sponsored.bytes`.
 */
export async function executeSponsored(
  digest: string,
  signature: string,
): Promise<{ digest: string }> {
  const enoki = getEnoki();
  try {
    const result = await enoki.executeSponsoredTransaction({ digest, signature });
    return { digest: result.digest };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // Breadcrumb for the most common drift mode: web's Enoki app and
    // server's Enoki app are different (so the zkLogin-derived sender on
    // the sponsored tx does not match the address that produced the
    // signature). Surface this loudly instead of letting it propagate as
    // a generic 500 the client cannot interpret.
    if (/signature|verify|sender/i.test(msg)) {
      console.error(
        '[enoki/execute] signature/sender mismatch — check ENOKI_PUBLIC_KEY (web) and ENOKI_PRIVATE_KEY (server) belong to the SAME Enoki app:',
        msg,
      );
    }
    throw e;
  }
}

/**
 * zkLogin branch of `createSponsoredTransaction`. Use this when the caller
 * authenticated via Enoki-managed Google OAuth and you have their JWT.
 *
 * Differences vs `sponsorForAddress`:
 *   - Sender is DERIVED from the JWT, not passed.
 *   - `allowedAddresses` / `allowedMoveCallTargets` are NOT accepted here
 *     (Enoki enforces JWT-bound sender, which is the safer primitive).
 *   - Returned `bytes` are signed by the EPHEMERAL keypair, then wrapped
 *     into a zkLogin signature blob via `executeSponsoredAsZkLoginUser`
 *     in `lib/zklogin.ts`.
 *
 * The JWT must be a fresh Google id_token; Enoki re-checks the audience
 * against the API key's registered client ID and rejects expired JWTs.
 */
export async function sponsorForZkLoginUser(
  tx: Transaction,
  jwt: string,
): Promise<SponsoredTxResult> {
  const enoki = getEnoki();
  const txKindBytes = await tx.build({
    client: suiGrpc as never,
    onlyTransactionKind: true,
  });
  const sponsored = await enoki.createSponsoredTransaction({
    network: SUI_NETWORK as 'mainnet' | 'testnet',
    transactionKindBytes: toBase64(txKindBytes),
    jwt,
  });
  return {
    digest: sponsored.digest,
    bytes: sponsored.bytes,
  };
}

/// Convenience re-exports.
export { fromBase64, toBase64 };
