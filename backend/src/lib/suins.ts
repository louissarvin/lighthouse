/**
 * SuiNS integration — name resolution + walrus_site_id metadata writes.
 *
 * Resolution: per researcher Q3, `SuinsClient` does NOT expose
 * `resolveNameServiceAddress`. The flat resolver lives on the core JSON-RPC
 * client (`SuiJsonRpcClient.resolveNameServiceAddress({ name })` returns
 * `string | null`). Source: `@mysten/sui/dist/jsonRpc/client.d.mts:319`.
 *
 * Writing metadata: `SuinsTransaction.setUserData({ nft, key, value, isSubname? })`
 * builds a Move call against `controller::set_user_data` (or the subdomain
 * proxy when `isSubname`). The `nft` parameter is the user's owned
 * `SuinsRegistration` NFT object id. Source: `@mysten/suins/dist/suins-transaction.d.mts:117-141`.
 *
 * Used by:
 *   - Public tearsheet route: resolve `alice.sui` to a Sui address.
 *   - Profile sync: write `walrus_site_id` to the user's `.sui` so
 *     `lighthouse.wal.app/u/<name>/...` resolves via the Walrus Sites portal.
 */

import { SuinsClient, SuinsTransaction } from '@mysten/suins';
import { Transaction } from '@mysten/sui/transactions';

import { SUI_NETWORK } from '../config/main-config.ts';
import { suiGrpc, suiRpc } from './sui.ts';

let _suinsClient: SuinsClient | null = null;

function getSuinsClient(): SuinsClient {
  if (!_suinsClient) {
    _suinsClient = new SuinsClient({
      client: suiGrpc as never,
      network: (SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet',
    });
  }
  return _suinsClient;
}

/**
 * Resolve a `.sui` name to a Sui address. Returns null when:
 *   - the name is not registered
 *   - the name has no target address set
 *   - the network is offline
 *
 * Public, no auth required (just an RPC read).
 */
export async function resolveSuiNS(name: string): Promise<string | null> {
  if (!name || !name.endsWith('.sui')) return null;
  try {
    const addr = await suiRpc.resolveNameServiceAddress({ name });
    return addr ?? null;
  } catch (e) {
    console.warn(`[suins] resolve(${name}) failed:`, (e as Error).message);
    return null;
  }
}

/**
 * Build a PTB that writes `walrus_site_id = siteObjectId` onto the user's
 * `SuinsRegistration` NFT.
 *
 * Caller (typically `/profile/set-walrus-site-id`) signs + executes (often
 * sponsored via Enoki). After the tx lands + the wal.app portal caches
 * propagate (~60s), the user's `name.wal.app` resolves to their site.
 *
 * @param nftId         User's `SuinsRegistration` NFT object id.
 * @param siteObjectId  The Walrus Sites Site object id.
 * @param isSubname     true if `name` is a subdomain (e.g. `app.alice.sui`).
 *                      Apex SLDs (alice.sui) pass false (default).
 */
export function buildSetWalrusSiteIdTx(
  nftId: string,
  siteObjectId: string,
  isSubname = false,
): Transaction {
  const suinsClient = getSuinsClient();
  const tx = new Transaction();
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  suinsTx.setUserData({
    nft: nftId,
    key: 'walrus_site_id', // exact snake_case from ALLOWED_METADATA
    value: siteObjectId,
    isSubname,
  });
  return tx;
}

/**
 * Reverse-lookup a Sui address → `.sui` name (best-effort).
 *
 * The SuiNS protocol stores a `default_name` field on the NameRecord; the
 * reverse path is rate-limited and may return null. We use it during
 * onboarding to seed `TraderProfile.suins_name`.
 */
export async function reverseSuiNS(_address: string): Promise<string | null> {
  // The JSON-RPC `resolveNameServiceNames` requires the address and returns
  // a paginated list — the first record is the user's preferred default
  // name. Defensive narrow because the typed shape varies across SDK
  // versions.
  const rpc = suiRpc as unknown as {
    resolveNameServiceNames?: (args: {
      address: string;
    }) => Promise<{ data?: string[]; nextCursor?: string | null }>;
  };
  if (typeof rpc.resolveNameServiceNames !== 'function') {
    return null;
  }
  try {
    const res = await rpc.resolveNameServiceNames({ address: _address });
    return res?.data?.[0] ?? null;
  } catch (e) {
    console.warn(`[suins] reverse(${_address}) failed:`, (e as Error).message);
    return null;
  }
}

/**
 * Normalise a SuiNS input: strips leading/trailing whitespace and ensures the
 * `.sui` suffix is present. Returns null if the input cannot be a valid SuiNS.
 * Use before `resolveSuiNS` to avoid RPC calls for obviously invalid names.
 */
export function normaliseSuiNSInput(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.includes('@')) return null          // email address
  if (trimmed.startsWith('0x')) return null       // raw Sui address
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.sui$/.test(trimmed)) {
    // missing .sui suffix — try appending
    const withSuffix = `${trimmed}.sui`
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.sui$/.test(withSuffix)) return withSuffix
    return null
  }
  return trimmed
}
