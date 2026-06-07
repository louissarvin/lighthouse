/**
 * SEAL client helpers for browser-side decryption.
 *
 * Key server IDs are hardcoded per sdk-installation.mdx:
 *   "@mysten/seal" is pinned to 1.1.3 — getAllowlistedKeyServers was removed
 *   from later versions; IDs must be hardcoded.
 *
 * Testnet IDs sourced from the Mysten SEAL documentation and the
 * lighthouse-sui/seal-policies.mdx in this repo.
 */

import { SealClient, SessionKey } from '@mysten/seal'
import type { SealCompatibleClient } from '@mysten/seal'

// Two testnet key servers: Mysten Labs primary + community fallback.
// These are object IDs on Sui testnet that implement the KeyServer interface.
const KEY_SERVER_CONFIGS = [
  {
    objectId:
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
    weight: 1,
  },
  {
    objectId:
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
    weight: 1,
  },
]

// Minimum number of key servers that must cooperate to decrypt.
export const SEAL_THRESHOLD = 2

export function getSealClient(suiClient: SealCompatibleClient): SealClient {
  return new SealClient({
    suiClient,
    serverConfigs: KEY_SERVER_CONFIGS,
    verifyKeyServers: false,
  })
}

export { SessionKey }
export type { SealCompatibleClient }
