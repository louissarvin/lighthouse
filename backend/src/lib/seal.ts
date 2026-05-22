/**
 * SEAL client (testnet).
 *
 * Sources:
 *   - https://seal-docs.wal.app/
 *   - memory/seal_reverify_2026_06.md (testnet IDs + canonical pattern)
 *
 * SECURITY:
 *   - SessionKey TTL is HARD-bounded 1..30 minutes. Default to 15.
 *   - `seal.encrypt` `aad` field binds ciphertext to its Walrus blob ID — pass
 *     the blob ID bytes so blob swapping is detected at decryption time.
 *   - Per LIGHTHOUSE.md §8.5 gotcha 14: once a copy-trader successfully
 *     `decrypt`s a slice, that plaintext is THEIRS forever. Revocation
 *     blocks future fetches; it does NOT retract past plaintext.
 *
 * For backend services we use a keypair-based SessionKey (Tier 1). User-facing
 * SDK flows (Enoki / zkLogin) use Tier 2 (onSign callback).
 */

import { SealClient, SessionKey } from '@mysten/seal';

import {
  LIGHTHOUSE_PACKAGE_ID,
  SEAL_AGGREGATOR_URL,
  SEAL_KEY_SERVER_IDS,
  SEAL_PACKAGE_ID,
} from '../config/main-config.ts';
import { suiRpc } from './sui.ts';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

if (!SEAL_KEY_SERVER_IDS.length) {
  console.warn(
    '[seal] SEAL_KEY_SERVER_IDS is empty. SEAL encrypt/decrypt will fail until you populate it.',
  );
}

/// Threshold: ceil(2N/3) per Lighthouse heuristic. With 2 servers, threshold = 2 (zero
/// fault tolerance — fine for demo). With 3 servers, threshold = 2 (tolerates 1 outage).
function thresholdFor(count: number): number {
  return Math.max(1, Math.ceil((2 * count) / 3));
}

/// Lazy-init since constructing SealClient requires SUI_RPC + key server IDs.
let _sealClient: SealClient | null = null;

export function getSealClient(): SealClient {
  if (!_sealClient) {
    _sealClient = new SealClient({
      suiClient: suiRpc as never, // SealClient accepts the RPC client shape
      serverConfigs: SEAL_KEY_SERVER_IDS.map((objectId, i) => ({
        objectId,
        weight: 1,
        // Only the FIRST server (committee) gets the aggregator URL.
        aggregatorUrl: i === 0 ? SEAL_AGGREGATOR_URL : undefined,
      })),
      verifyKeyServers: true,
      timeout: 10_000,
    });
  }
  return _sealClient;
}

/**
 * Create a SessionKey for backend keypair signing (Tier 1).
 *
 * @param ownerAddress  The Sui address that owns the TraderProfile (for sender check).
 * @param signer        Backend keypair. Lighthouse uses the coach keypair for
 *                      reads where the coach has been granted access.
 * @param ttlMin        1..30. Default 15.
 */
export async function createSessionKey(
  ownerAddress: string,
  signer: Ed25519Keypair,
  ttlMin = 15,
): Promise<SessionKey> {
  if (ttlMin < 1 || ttlMin > 30) {
    throw new Error(`[seal] ttlMin out of range (1..30), got ${ttlMin}`);
  }
  return await SessionKey.create({
    address: ownerAddress,
    packageId: LIGHTHOUSE_PACKAGE_ID || SEAL_PACKAGE_ID,
    ttlMin,
    mvrName: '@lighthouse/trader_profile',
    suiClient: suiRpc as never,
    signer,
  });
}

/**
 * Encrypt arbitrary bytes against a SEAL identity. The `id` is the inner-id
 * byte string used in the `seal_approve_*` policy gate (see
 * LIGHTHOUSE.md §8.1 layout: `[profile_id_32][':'][slice_utf8]`).
 *
 * @param innerId  Hex string of the inner-id bytes (will be passed as-is).
 * @param data     Plaintext to encrypt.
 * @param blobId   Walrus blob ID this ciphertext will live under. Used as AAD
 *                 to detect blob swapping.
 * @param threshold  How many key servers must sign to decrypt. Defaults to ceil(2N/3).
 */
export async function sealEncrypt(
  innerId: string,
  data: Uint8Array,
  blobId: string,
  threshold?: number,
): Promise<{ encryptedObject: Uint8Array; backupKey: Uint8Array }> {
  const seal = getSealClient();
  const result = await seal.encrypt({
    packageId: LIGHTHOUSE_PACKAGE_ID || SEAL_PACKAGE_ID,
    id: innerId,
    data,
    threshold: threshold ?? thresholdFor(SEAL_KEY_SERVER_IDS.length),
    aad: new TextEncoder().encode(blobId),
  });
  return { encryptedObject: result.encryptedObject, backupKey: result.key };
}

/**
 * Decrypt a SEAL-encrypted blob. Caller must provide a SessionKey AND the dry-run
 * `seal_approve_*` PTB bytes that authorise the read.
 */
export async function sealDecrypt(
  encryptedObject: Uint8Array,
  sessionKey: SessionKey,
  txBytes: Uint8Array,
): Promise<Uint8Array> {
  const seal = getSealClient();
  return await seal.decrypt({
    data: encryptedObject,
    sessionKey,
    txBytes,
  });
}

/**
 * Batch decrypt multiple SEAL ciphertexts that share the same SEAL identity
 * AND the same `seal_approve_*` PTB. Pre-fetches keys for all `ids` in one
 * round trip via `client.fetchKeys`, then calls `decrypt` per ciphertext (the
 * subsequent `decrypt` calls use the cached keys with no extra network).
 *
 * Use case: weekly Quilt where multiple slices live under the same
 * `[profile_id]:trades` identity. One sponsored dry-run PTB authorises all
 * reads at once.
 *
 * Source: `@mysten/seal@1.1.3/dist/client.d.mts` `fetchKeys` accepts an
 * `ids: string[]` array; per its docstring "the function returns when a
 * threshold of key servers had returned keys for all ids."
 */
export interface SealBatchEntry {
  /// Hex inner-id string (e.g. from `buildSealIdentity(profileId, slice)`).
  identityHex: string;
  /// SEAL ciphertext for this identity.
  encryptedObject: Uint8Array;
}

export async function sealDecryptBatch(
  entries: SealBatchEntry[],
  sessionKey: SessionKey,
  txBytes: Uint8Array,
  threshold?: number,
): Promise<Uint8Array[]> {
  if (entries.length === 0) return [];
  const seal = getSealClient();
  const t = threshold ?? thresholdFor(SEAL_KEY_SERVER_IDS.length);

  // Pre-fetch keys for ALL identities in ONE round trip.
  await seal.fetchKeys({
    ids: entries.map((e) => e.identityHex),
    txBytes,
    sessionKey,
    threshold: t,
  });

  // Now decrypt each — these calls hit the in-memory key cache.
  return Promise.all(
    entries.map((e) =>
      seal.decrypt({
        data: e.encryptedObject,
        sessionKey,
        txBytes,
      }),
    ),
  );
}
