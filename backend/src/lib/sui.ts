/**
 * Sui client singletons.
 *
 * Two clients are exposed:
 *   - `suiGrpc` (SuiGrpcClient): preferred for queries + tx execution. JSON-RPC
 *     sunsets July 2026; gRPC is forward-compatible. Source:
 *     https://sdk.mystenlabs.com/typescript/grpc
 *   - `suiRpc` (SuiClient): legacy JSON-RPC, retained ONLY for `subscribeEvent`
 *     and `queryEvents` (gRPC `SubscriptionServiceClient` is not yet wired into
 *     the public SuiGrpcClient API as of `@mysten/sui@2.17.0`).
 *
 * Both share the same network. Switch via `SUI_NETWORK` env var.
 */

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { SUI_NETWORK, SUI_RPC_URL } from '../config/main-config.ts';

/// Forward-compatible gRPC client. Use for queries, tx execution, dry-run.
export const suiGrpc = new SuiGrpcClient({
  network: SUI_NETWORK,
  baseUrl: SUI_RPC_URL,
});

/// Legacy JSON-RPC client. Use ONLY for event polling (`queryEvents`).
/// `@mysten/sui@2.17.0` no longer exposes `SuiClient` directly; the equivalent
/// is `SuiJsonRpcClient`, which extends `BaseClient` with the legacy RPC API.
export const suiRpc = new SuiJsonRpcClient({
  network: SUI_NETWORK,
  url: SUI_RPC_URL,
});

/**
 * Convenience helper for indexer + keeper loops: get current checkpoint.
 */
export async function getLatestCheckpoint(): Promise<string> {
  return await suiRpc.getLatestCheckpointSequenceNumber();
}

/**
 * Shorten a Sui address for logging (keeps first 6 + last 4 chars).
 * Avoids importing miscUtils in hot paths.
 */
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
