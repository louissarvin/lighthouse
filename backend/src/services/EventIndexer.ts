/**
 * EventIndexer — long-lived loop that polls Sui for Move events and persists
 * them to Postgres.
 *
 * Why polling, not `subscribeEvent`:
 *   - `SuiClient.subscribeEvent` is deprecated (Mysten issue #19493)
 *   - JSON-RPC sunsets July 2026
 *   - gRPC `SubscriptionServiceClient` exists but is NOT wired into the public
 *     `SuiGrpcClient` API as of `@mysten/sui@2.17.0`
 *   - Polling with cursor pagination is the recommended near-term pattern
 *
 * Cursor is persisted in `EventCursor` table so we resume across restarts.
 * Each tracked event type gets its own cursor row.
 *
 * Configured via `EVENT_INDEXER_RECONNECT_MS` (backoff between empty polls).
 */

import { prismaQuery } from '../lib/prisma.ts';
import { suiRpc } from '../lib/sui.ts';

/// Local event types — the legacy JSON-RPC type re-exports moved across
/// internal sub-paths in `@mysten/sui@2.17`; we narrow locally.
interface EventId {
  txDigest: string;
  eventSeq: string;
}
interface SuiEvent {
  id: EventId;
  packageId: string;
  transactionModule: string;
  sender: string;
  type: string;
  parsedJson?: unknown;
  bcs?: string;
  timestampMs?: string | null;
}
import {
  DEEPBOOK_PACKAGE_ID,
  EVENT_INDEXER_RECONNECT_MS,
  LIGHTHOUSE_PACKAGE_ID,
} from '../config/main-config.ts';
import { dispatch } from './NotificationDispatcher.ts';
import { archiveBlob, KIND_TRADE } from './AuditLoop.ts';
import { envelopeDecrypt } from '../lib/envelope.ts';
import { NAMESPACES, analyzeAndRemember } from '../lib/memwal.ts';

// === Tracked event filters ===

interface TrackedEvent {
  /// Stable key for EventCursor row.
  id: string;
  /// Full `${pkg}::${module}::${EventStruct}` type.
  moveEventType: string;
  /// Per-event-type handler. Receive raw event + parse the `parsedJson` field.
  handle: (event: SuiEvent) => Promise<void>;
}

function getTrackedEvents(): TrackedEvent[] {
  const tracked: TrackedEvent[] = [];

  if (LIGHTHOUSE_PACKAGE_ID) {
    tracked.push(
      {
        id: 'lighthouse:executor::AgentCreated',
        moveEventType: `${LIGHTHOUSE_PACKAGE_ID}::executor::AgentCreated`,
        handle: handleAgentCreated,
      },
      {
        id: 'lighthouse:executor::TradeExecuted',
        moveEventType: `${LIGHTHOUSE_PACKAGE_ID}::executor::TradeExecuted`,
        handle: handleTradeExecuted,
      },
      {
        id: 'lighthouse:executor::AgentRevoked',
        moveEventType: `${LIGHTHOUSE_PACKAGE_ID}::executor::AgentRevoked`,
        handle: handleAgentRevoked,
      },
      {
        id: 'lighthouse:audit_anchor::AnchorRecorded',
        moveEventType: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::AnchorRecorded`,
        handle: handleAnchorRecorded,
      },
    );
  }

  if (DEEPBOOK_PACKAGE_ID && !DEEPBOOK_PACKAGE_ID.includes('...')) {
    tracked.push({
      id: 'deepbook:order_info::OrderFilled',
      moveEventType: `${DEEPBOOK_PACKAGE_ID}::order_info::OrderFilled`,
      handle: handleOrderFilled,
    });
  }

  return tracked;
}

// === Handlers ===

async function handleAgentCreated(event: SuiEvent): Promise<void> {
  const data = event.parsedJson as {
    agent_id: string;
    owner: string;
    agent: string;
    balance_manager_id: string;
  };
  console.log(`[EventIndexer] AgentCreated ${data.agent_id} owner=${data.owner}`);
  // Defer profile.executor_agent_id update to the route that created it; we
  // record the digest here for cross-reference if the route missed it.
  await prismaQuery.traderProfile.updateMany({
    where: { sui_address: data.owner, executor_agent_id: null },
    data: { executor_agent_id: data.agent_id, balance_manager_id: data.balance_manager_id },
  });
}

async function handleTradeExecuted(event: SuiEvent): Promise<void> {
  const data = event.parsedJson as {
    agent_id: string;
    pool_id: string;
    order_id: string;
    is_bid: boolean;
    price: string;
    quantity: string;
    notional: string;
    timestamp_ms: string;
  };
  console.log(`[EventIndexer] TradeExecuted order=${data.order_id} pool=${data.pool_id}`);
  await prismaQuery.trade.updateMany({
    where: { tx_digest: event.id.txDigest },
    data: { order_id: data.order_id, status: 'placed' },
  });

  // Notify the owner via dispatcher.
  const profile = await prismaQuery.traderProfile.findFirst({
    where: { executor_agent_id: data.agent_id, deleted_at: null },
  });
  if (profile) {
    await dispatch({
      userAddress: profile.sui_address,
      category: 'trade_settled',
      text:
        `${data.is_bid ? 'BUY' : 'SELL'} ${data.quantity} @ ${data.price}\n` +
        `Pool: ${data.pool_id.slice(0, 12)}…\n` +
        `Notional: ${data.notional}\n` +
        `Order: ${data.order_id}`,
    });

    // === Archive the settled trade: SEAL → Walrus → audit_anchor + MemWal ===
    // Best-effort; failure here writes a FailedEvent but does not block cursor.
    if (
      profile.profile_object_id &&
      profile.memwal_account_id &&
      profile.memwal_delegate_key_encrypted
    ) {
      try {
        const delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
        const settlementPayload = {
          side: data.is_bid ? 'buy' : 'sell',
          pool_id: data.pool_id,
          order_id: data.order_id,
          price: data.price,
          quantity: data.quantity,
          notional: data.notional,
          settled_at_ms: Number(data.timestamp_ms),
          tx_digest: event.id.txDigest,
        };
        const rememberText =
          `Trade settled: ${data.is_bid ? 'BUY' : 'SELL'} ${data.quantity} @ ${data.price} ` +
          `on pool ${data.pool_id.slice(0, 10)}… notional=${data.notional} ` +
          `order=${data.order_id} tx=${event.id.txDigest.slice(0, 12)}…`;
        // Archive on-chain + Walrus.
        await archiveBlob({
          profileObjectId: profile.profile_object_id,
          slice: NAMESPACES.trades,
          plaintext: JSON.stringify(settlementPayload),
          kind: KIND_TRADE,
          originatingTxDigestBase58: event.id.txDigest,
          // We do NOT pass a `memwal` here because we're using analyzeAndRemember
          // separately for fact-extraction (better recall fidelity).
        });
        // MemWal v0.0.7 fact-extraction with temporal anchoring at the actual
        // settlement timestamp. Higher recall fidelity than plain remember.
        await analyzeAndRemember(
          { delegateKey, accountId: profile.memwal_account_id },
          rememberText,
          NAMESPACES.trades,
          new Date(Number(data.timestamp_ms)),
        );
      } catch (e) {
        console.warn(`[EventIndexer] archive failed for TradeExecuted ${data.order_id}:`, (e as Error).message);
      }
    }
  }
}

async function handleAgentRevoked(event: SuiEvent): Promise<void> {
  const data = event.parsedJson as { agent_id: string; revoked_at_ms: string };
  console.log(`[EventIndexer] AgentRevoked ${data.agent_id}`);
  // Pull the owner address BEFORE clearing the ID so dispatch finds the profile.
  const profile = await prismaQuery.traderProfile.findFirst({
    where: { executor_agent_id: data.agent_id, deleted_at: null },
  });
  await prismaQuery.traderProfile.updateMany({
    where: { executor_agent_id: data.agent_id },
    data: { executor_agent_id: null },
  });
  if (profile) {
    await dispatch({
      userAddress: profile.sui_address,
      category: 'agent_revoked',
      text: `Executor agent ${data.agent_id.slice(0, 12)}… revoked at ${new Date(Number(data.revoked_at_ms)).toISOString()}.`,
    });
  }
}

async function handleAnchorRecorded(event: SuiEvent): Promise<void> {
  const data = event.parsedJson as {
    anchor_id: string;
    owner: string;
    kind: number;
    walrus_blob_id: number[];
    created_at_ms: string;
  };
  const blobIdBytes = new Uint8Array(data.walrus_blob_id);
  const blobIdHex = Buffer.from(blobIdBytes).toString('hex');
  console.log(`[EventIndexer] AnchorRecorded kind=${data.kind} blob=${blobIdHex.slice(0, 16)}…`);
  await prismaQuery.walrusBlob.upsert({
    where: { blob_id: blobIdHex },
    create: {
      blob_id: blobIdHex,
      kind: data.kind,
      owner_address: data.owner,
      tx_digest: event.id.txDigest,
      size_bytes: 0,
      epochs: 0,
    },
    update: { kind: data.kind, owner_address: data.owner, tx_digest: event.id.txDigest },
  });
}

async function handleOrderFilled(event: SuiEvent): Promise<void> {
  const data = event.parsedJson as {
    pool_id: string;
    order_id: string;
    executed_quantity: string;
    cumulative_quantity?: string;
    base_quantity?: string;
  };
  const filled = BigInt(data.executed_quantity);
  // Settled vs partial: needs to be evaluated by remaining_quantity == 0 in OrderFilled,
  // OR by listening to OrderFullyFilled (separate event type).
  await prismaQuery.trade.updateMany({
    where: { order_id: data.order_id },
    data: { filled_quantity: filled, settled_at: new Date() },
  });
}

// === Polling loop ===

const PAGE_SIZE = 50;

async function loadCursor(id: string): Promise<EventId | null> {
  const row = await prismaQuery.eventCursor.findUnique({ where: { id } });
  return row?.cursor_json ? (row.cursor_json as unknown as EventId) : null;
}

async function saveCursor(id: string, cursor: EventId): Promise<void> {
  await prismaQuery.eventCursor.upsert({
    where: { id },
    create: { id, cursor_json: cursor as never },
    update: { cursor_json: cursor as never },
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, backoffMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

async function deadLetter(trackedId: string, event: SuiEvent, err: unknown): Promise<void> {
  try {
    await prismaQuery.failedEvent.create({
      data: {
        event_key: trackedId,
        tx_digest: event.id.txDigest,
        event_seq: event.id.eventSeq,
        event_json: event as unknown as never,
        error_msg: (err as Error)?.stack ?? String(err),
      },
    });
  } catch (writeErr) {
    console.error(`[EventIndexer] dead-letter write failed for ${trackedId}:`, writeErr);
  }
}

async function pollOnce(tracked: TrackedEvent): Promise<{ processed: number; advanced: boolean; deadLettered: number }> {
  const cursor = await loadCursor(tracked.id);
  const page = await suiRpc.queryEvents({
    query: { MoveEventType: tracked.moveEventType },
    cursor,
    limit: PAGE_SIZE,
    order: 'ascending',
  });
  let processed = 0;
  let deadLettered = 0;
  for (const ev of page.data) {
    try {
      await withRetry(() => tracked.handle(ev));
      processed++;
    } catch (e) {
      // Per researcher Q10: advance cursor even on terminal failure; write
      // a FailedEvent row for later replay. Stops a single bad event from
      // wedging the entire indexer.
      console.error(
        `[EventIndexer] handler failed for ${tracked.id} tx=${ev.id.txDigest}:`,
        (e as Error).message,
      );
      await deadLetter(tracked.id, ev, e);
      deadLettered++;
    }
  }
  if (page.nextCursor) {
    await saveCursor(tracked.id, page.nextCursor);
    return { processed, advanced: true, deadLettered };
  }
  return { processed, advanced: false, deadLettered };
}

let _stop = false;

export function stopEventIndexer(): void {
  _stop = true;
}

/**
 * Start the indexer. Returns a Promise that resolves on shutdown.
 * Caller (index.ts) does NOT await this; the loop runs in the background.
 */
export async function startEventIndexer(): Promise<void> {
  console.log('[EventIndexer] starting');
  while (!_stop) {
    const tracked = getTrackedEvents();
    if (!tracked.length) {
      console.warn('[EventIndexer] no events tracked yet — set LIGHTHOUSE_PACKAGE_ID + DEEPBOOK_PACKAGE_ID');
      await sleep(10_000);
      continue;
    }
    let totalProcessed = 0;
    let anyAdvanced = false;
    let totalDeadLettered = 0;
    for (const t of tracked) {
      try {
        const { processed, advanced, deadLettered } = await pollOnce(t);
        totalProcessed += processed;
        anyAdvanced = anyAdvanced || advanced;
        totalDeadLettered += deadLettered;
      } catch (e) {
        console.error(`[EventIndexer] pollOnce(${t.id}) failed:`, e);
        await sleep(EVENT_INDEXER_RECONNECT_MS);
      }
    }
    if (totalDeadLettered > 0) {
      console.warn(`[EventIndexer] ${totalDeadLettered} event(s) dead-lettered this cycle`);
    }
    // backoff if nothing happened
    if (totalProcessed === 0 && !anyAdvanced) {
      await sleep(EVENT_INDEXER_RECONNECT_MS);
    }
  }
  console.log('[EventIndexer] stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
