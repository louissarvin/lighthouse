export const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space'

/**
 * Returns the full Walrus aggregator URL for a blob ID, or null if the ID is
 * absent. All components that render Walrus links should import from here so
 * the aggregator base lives in exactly one place.
 */
export function walrusBlobUrl(blobId: string | null | undefined): string | null {
  if (!blobId) return null
  return `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`
}
