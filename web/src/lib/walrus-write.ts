/**
 * Browser-side Walrus blob upload.
 *
 * Uses @mysten/walrus WalrusClient directly — the user signs the storage
 * registration transaction with their Enoki ephemeral key, so the resulting
 * blob object is owned by the user, not the backend.
 *
 * Requires the user to have WAL tokens for storage cost.
 */

import { WalrusClient } from '@mysten/walrus'
import type { Signer } from '@mysten/sui/cryptography'
import type { ClientWithCoreApi } from '@mysten/sui/client'

// Number of Walrus epochs to store blobs (each epoch ~1 day on testnet).
const WALRUS_EPOCHS = 5

let _cachedClient: WalrusClient | null = null

export function getWalrusClient(suiClient: ClientWithCoreApi): WalrusClient {
  if (!_cachedClient) {
    _cachedClient = new WalrusClient({
      network: 'testnet',
      suiClient,
    })
  }
  return _cachedClient
}

export interface WalrusUploadResult {
  blobId: string
  suiObjectId: string
}

/**
 * Encode text, register a blob on Sui, upload shards to storage nodes, and
 * certify — all signed by the caller's Enoki ephemeral key.
 *
 * The signer must conform to @mysten/sui Signer (has `signTransaction`).
 */
export async function uploadTextToWalrus(
  text: string,
  suiClient: ClientWithCoreApi,
  signer: Signer,
): Promise<WalrusUploadResult> {
  const client = getWalrusClient(suiClient)
  const blob = new TextEncoder().encode(text)

  const result = await client.writeBlob({
    blob,
    deletable: false,
    epochs: WALRUS_EPOCHS,
    signer,
  })

  return {
    blobId: result.blobId,
    suiObjectId: result.blobObject.id,
  }
}

/**
 * Upload raw bytes to Walrus. Used for binary blobs (avatar images etc.)
 * where the caller has already encoded/resized the data.
 *
 * Same signing model as uploadTextToWalrus — the user's Enoki ephemeral key
 * pays for and owns the resulting blob object.
 */
export async function uploadBlobToWalrus(
  bytes: Uint8Array,
  suiClient: ClientWithCoreApi,
  signer: Signer,
  opts?: { deletable?: boolean; epochs?: number },
): Promise<WalrusUploadResult> {
  const client = getWalrusClient(suiClient)

  const result = await client.writeBlob({
    blob: bytes,
    deletable: opts?.deletable ?? false,
    epochs: opts?.epochs ?? WALRUS_EPOCHS,
    signer,
  })

  return {
    blobId: result.blobId,
    suiObjectId: result.blobObject.id,
  }
}
