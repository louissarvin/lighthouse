/**
 * On-chain `ExecutorAgent` state fetcher.
 *
 * Source: `executor.move:69-94` defines the struct; `@mysten/sui@2.17.0`
 * `SuiGrpcClient.getObject({ include: { json: true } })` returns parsed JSON
 * fields. We use the json shape for simplicity (rather than BCS deserialise)
 * because the agent's struct mixes our types with DeepBook's `TradeCap`
 * (opaque), which complicates a fully-BCS round-trip.
 *
 * Returns the seven fields needed for Guardian budget validation:
 *   - allowed_pools (string[] of object IDs)
 *   - max_notional_per_trade (bigint)
 *   - max_notional_per_day   (bigint)
 *   - spent_today           (bigint)
 *   - window_start_ms       (bigint)
 *   - expires_at_ms         (bigint)
 *   - revoked               (boolean)
 *
 * Per-profile cache lives on `TraderProfile.executor_agent_cache_json` with
 * a TTL of `EXECUTOR_AGENT_CACHE_TTL_MS`.
 */

import { prismaQuery } from './prisma.ts';
import { suiGrpc } from './sui.ts';
import { EXECUTOR_AGENT_CACHE_TTL_MS } from '../config/main-config.ts';

export interface ExecutorAgentSnapshot {
  agent_address: string;
  owner_address: string;
  balance_manager_id: string;
  allowed_pools: string[];
  max_notional_per_trade: bigint;
  max_notional_per_day: bigint;
  spent_today: bigint;
  window_start_ms: bigint;
  expires_at_ms: bigint;
  revoked: boolean;
}

/// Internal — raw JSON shape returned by SuiGrpcClient with `include: { json: true }`.
interface RawAgent {
  agent_address: string;
  owner_address: string;
  balance_manager_id: string;
  allowed_pools: string[];
  max_notional_per_trade: string | number;
  max_notional_per_day: string | number;
  spent_today: string | number;
  window_start_ms: string | number;
  expires_at_ms: string | number;
  revoked: boolean;
}

/**
 * Fetch the live ExecutorAgent shared object and return its scalar fields.
 * Throws if the object is missing, deleted, or has a different Move type.
 */
export async function fetchExecutorAgent(agentObjectId: string): Promise<ExecutorAgentSnapshot> {
  const resp = await suiGrpc.getObject({
    objectId: agentObjectId,
    include: { json: true },
  });
  // SDK shape: resp.object.json is the parsed Move struct fields, OR null if
  // the object has no content (deleted / not found / wrong filter).
  const obj = (resp as { object?: { json?: unknown } | null }).object;
  if (!obj || !obj.json) {
    throw new Error(`[onChainAgent] ExecutorAgent ${agentObjectId} not found or empty content`);
  }
  const raw = obj.json as RawAgent;
  return {
    agent_address: raw.agent_address,
    owner_address: raw.owner_address,
    balance_manager_id: raw.balance_manager_id,
    allowed_pools: raw.allowed_pools ?? [],
    max_notional_per_trade: BigInt(raw.max_notional_per_trade),
    max_notional_per_day: BigInt(raw.max_notional_per_day),
    spent_today: BigInt(raw.spent_today),
    window_start_ms: BigInt(raw.window_start_ms),
    expires_at_ms: BigInt(raw.expires_at_ms),
    revoked: !!raw.revoked,
  };
}

/**
 * Cached fetch: returns the cached snapshot if newer than the TTL; otherwise
 * fetches from chain, writes the cache, returns the fresh snapshot.
 */
export async function getCachedExecutorAgent(
  profileId: string,
  agentObjectId: string,
): Promise<ExecutorAgentSnapshot> {
  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: { executor_agent_cache_json: true, executor_agent_cache_at: true },
  });
  const now = Date.now();
  if (
    profile?.executor_agent_cache_json &&
    profile?.executor_agent_cache_at &&
    now - profile.executor_agent_cache_at.getTime() < EXECUTOR_AGENT_CACHE_TTL_MS
  ) {
    return rehydrate(profile.executor_agent_cache_json);
  }
  const fresh = await fetchExecutorAgent(agentObjectId);
  await prismaQuery.traderProfile.update({
    where: { id: profileId },
    data: {
      executor_agent_cache_json: serialize(fresh) as unknown as never,
      executor_agent_cache_at: new Date(now),
    },
  });
  return fresh;
}

/// Convert bigints to strings for JSON storage.
function serialize(s: ExecutorAgentSnapshot): Record<string, unknown> {
  return {
    agent_address: s.agent_address,
    owner_address: s.owner_address,
    balance_manager_id: s.balance_manager_id,
    allowed_pools: s.allowed_pools,
    max_notional_per_trade: s.max_notional_per_trade.toString(),
    max_notional_per_day: s.max_notional_per_day.toString(),
    spent_today: s.spent_today.toString(),
    window_start_ms: s.window_start_ms.toString(),
    expires_at_ms: s.expires_at_ms.toString(),
    revoked: s.revoked,
  };
}

function rehydrate(j: unknown): ExecutorAgentSnapshot {
  const r = j as Record<string, unknown>;
  return {
    agent_address: String(r.agent_address),
    owner_address: String(r.owner_address),
    balance_manager_id: String(r.balance_manager_id),
    allowed_pools: (r.allowed_pools as string[]) ?? [],
    max_notional_per_trade: BigInt(r.max_notional_per_trade as string),
    max_notional_per_day: BigInt(r.max_notional_per_day as string),
    spent_today: BigInt(r.spent_today as string),
    window_start_ms: BigInt(r.window_start_ms as string),
    expires_at_ms: BigInt(r.expires_at_ms as string),
    revoked: !!r.revoked,
  };
}
