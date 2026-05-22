/**
 * Sui Stack Messaging client (testnet).
 *
 * Source: https://github.com/MystenLabs/sui-stack-messaging
 *   - Factory: `createSuiStackMessagingClient(sui, opts)`
 *   - `client.messaging.createAndShareGroup({ signer, name, uuid, initialMembers })`
 *     returns `{ digest, effects }` (uuid is INPUT, NOT returned)
 *   - `client.messaging.sendMessage({ signer, groupRef: { uuid }, text? })`
 *   - `client.messaging.subscribe({ signer, groupRef, signal })` → async iterable
 *
 * RELAYER:
 *   - A relayer URL is REQUIRED. No in-process fallback exists.
 *   - For testnet you must self-host the upstream relayer OR ask Mysten for a
 *     hosted URL on Discord (per LIGHTHOUSE.md §5.5.7).
 *   - If `RELAYER_URL` is not set we return a stub client that throws on use
 *     so callers can degrade gracefully.
 *
 * SECURITY:
 *   - The creator is AUTO-GRANTED all permissions; do NOT include the creator
 *     in `initialMembers` (per upstream docstring).
 *   - Pre-generate UUIDs client-side and persist them — `createAndShareGroup`
 *     does not return the uuid.
 */

import { randomUUID } from 'node:crypto';
import { createSuiStackMessagingClient } from '@mysten/sui-stack-messaging';

import {
  LIGHTHOUSE_PACKAGE_ID,
  RELAYER_URL,
  SEAL_KEY_SERVER_IDS,
} from '../config/main-config.ts';
import { suiGrpc } from './sui.ts';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface MessagingClient {
  /** True if the relayer URL is configured and the client is real. */
  enabled: boolean;
  /** Throws if `enabled === false`. */
  createAndShareGroup(args: {
    signer: Ed25519Keypair;
    name: string;
    uuid: string;
    initialMembers: string[];
  }): Promise<{ digest: string }>;
  sendMessage(args: {
    signer: Ed25519Keypair;
    groupUuid: string;
    text: string;
  }): Promise<{ messageId: string }>;
  /** AsyncIterable of incoming messages. Aborts when `signal` fires. */
  subscribe(args: {
    signer: Ed25519Keypair;
    groupUuid: string;
    signal: AbortSignal;
  }): AsyncIterable<MessagingMessage>;
  /**
   * One-shot fetch of historical messages for a group. Newest-first when
   * `limit` is set; the upstream SDK paginates by `beforeOrder` / `afterOrder`
   * but for our HTTP read surface we just pull the most recent `limit`.
   */
  getMessages(args: {
    signer: Ed25519Keypair;
    groupUuid: string;
    limit?: number;
  }): Promise<{ messages: MessagingDecryptedMessage[]; hasNext: boolean }>;
}

/// Mirrors `DecryptedMessage` from `@mysten/sui-stack-messaging`. We keep a
/// local copy so the rest of the backend does not have to import the SDK type
/// transitively just to type the read response.
export interface MessagingDecryptedMessage {
  messageId: string;
  groupId: string;
  order: number;
  text: string;
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  senderVerified: boolean;
}

export interface MessagingMessage {
  id: string;
  groupUuid: string;
  sender: string;
  text?: string;
  timestampMs: number;
}

let _cache: MessagingClient | null = null;

/**
 * Get-or-create the messaging client. If `RELAYER_URL` is empty we return a
 * disabled stub so the rest of the backend keeps booting.
 */
export function getMessaging(signer: Ed25519Keypair): MessagingClient {
  if (_cache) return _cache;

  if (!RELAYER_URL) {
    console.warn(
      '[messaging] RELAYER_URL is not set — Sui Stack Messaging is disabled. ' +
        'Deploy upstream relayer or set RELAYER_URL to enable group chat features.',
    );
    _cache = makeDisabledStub();
    return _cache;
  }

  if (!SEAL_KEY_SERVER_IDS.length) {
    throw new Error('[messaging] SEAL_KEY_SERVER_IDS must be set to use messaging');
  }
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[messaging] LIGHTHOUSE_PACKAGE_ID must be set to use messaging');
  }

  const inner = createSuiStackMessagingClient(suiGrpc as never, {
    seal: {
      serverConfigs: SEAL_KEY_SERVER_IDS.map((objectId) => ({ objectId, weight: 1 })),
    },
    encryption: {
      // Tier 1: backend-keypair-driven SessionKey (Enoki/zkLogin flow on the
      // frontend uses Tier 2). The signer here drives SessionKey refresh
      // automatically — SDK refreshes 60s before expiry.
      sessionKey: { signer },
    },
    relayer: {
      relayerUrl: RELAYER_URL,
    },
  });

  _cache = {
    enabled: true,
    async createAndShareGroup(args) {
      const res = await inner.messaging.createAndShareGroup({
        signer: args.signer,
        name: args.name,
        uuid: args.uuid,
        initialMembers: args.initialMembers,
      });
      return { digest: res.digest };
    },
    async sendMessage(args) {
      const res = await inner.messaging.sendMessage({
        signer: args.signer,
        groupRef: { uuid: args.groupUuid },
        text: args.text,
      });
      return { messageId: res.messageId };
    },
    subscribe(args): AsyncIterable<MessagingMessage> {
      const stream = inner.messaging.subscribe({
        signer: args.signer,
        groupRef: { uuid: args.groupUuid },
        signal: args.signal,
      });
      return mapAsyncIterable(stream, (m) => ({
        id: (m as { messageId?: string; id?: string }).messageId ?? (m as { id?: string }).id ?? '',
        groupUuid: args.groupUuid,
        sender: (m as { sender?: string }).sender ?? '',
        text: (m as { text?: string }).text,
        timestampMs:
          Number((m as { timestampMs?: number | string }).timestampMs ?? Date.now()) || Date.now(),
      }));
    },
    async getMessages(args) {
      // Upstream SDK exposes `client.messaging.getMessages({ signer, groupRef,
      // afterOrder?, beforeOrder?, limit? })` returning
      // `{ messages: DecryptedMessage[]; hasNext: boolean }` per
      // node_modules/@mysten/sui-stack-messaging/dist/messaging-types.d.mts.
      // The SDK paginates by `order` (monotonic, set by the on-chain channel
      // contract) — passing no cursor + a limit returns the most recent N.
      const res = await inner.messaging.getMessages({
        signer: args.signer,
        groupRef: { uuid: args.groupUuid },
        limit: args.limit,
      });
      const mapped: MessagingDecryptedMessage[] = (res.messages ?? []).map((m) => ({
        messageId: m.messageId,
        groupId: m.groupId,
        order: m.order,
        text: m.text,
        senderAddress: m.senderAddress,
        createdAt: Number(m.createdAt) || 0,
        updatedAt: Number(m.updatedAt) || 0,
        isEdited: !!m.isEdited,
        isDeleted: !!m.isDeleted,
        senderVerified: !!m.senderVerified,
      }));
      return { messages: mapped, hasNext: !!res.hasNext };
    },
  };
  return _cache;
}

/**
 * Generate a new group UUID for persistence on the user's TraderProfile.
 * Sub Stack Messaging does NOT return uuids from createAndShareGroup so we
 * must pre-generate.
 */
export function newGroupUuid(): string {
  return randomUUID();
}

/** Stub that returns `enabled: false` and throws on any operation. */
function makeDisabledStub(): MessagingClient {
  const reject = (): Promise<never> =>
    Promise.reject(new Error('[messaging] disabled: set RELAYER_URL to enable'));
  return {
    enabled: false,
    createAndShareGroup: reject as MessagingClient['createAndShareGroup'],
    sendMessage: reject as MessagingClient['sendMessage'],
    subscribe(): AsyncIterable<MessagingMessage> {
      return (async function* () {
        throw new Error('[messaging] disabled: set RELAYER_URL to enable');
      })();
    },
    getMessages: reject as MessagingClient['getMessages'],
  };
}

async function* mapAsyncIterable<A, B>(
  src: AsyncIterable<A>,
  fn: (a: A) => B,
): AsyncIterable<B> {
  for await (const a of src) yield fn(a);
}

// ─── Coach-side messaging helpers ────────────────────────────────────────
//
// SPONSOR NOTE: `@mysten/sui-stack-messaging`'s SDK is keypair-driven —
// `createAndShareGroup` and `sendMessage` internally build + sign the PTB
// using the supplied signer. They do NOT expose a "build only" mode that
// would let us extract `transactionKindBytes` and route through Enoki.
//
// Workaround: use the Coach keypair as the signer. The Coach pays gas +
// WAL for every group creation and message. From the user's perspective,
// the bot still operates "for free" because they never sign anything.
//
// This is acceptable for the v1 bot UX: a group is created when the user
// onboards, and the Coach posts messages on the user's behalf when the
// AI ships an output. If we later need end-user-initiated messages
// (without Coach payment), we will need to either:
//   (a) implement our own PTB builders against the messaging module
//       directly, OR
//   (b) wait for the SDK to expose `onlyTransactionKind` mode.

import { getCoachKeypair } from './keypairs.ts';

export interface CoachGroupResult {
  uuid: string;
  digest: string;
}

/**
 * Create a Sui Stack Messaging group signed + paid by the Coach keypair.
 * The Coach is auto-granted all permissions (don't include in `members`).
 *
 * Returns the pre-generated UUID + tx digest. Caller persists the UUID on
 * the user's TraderProfile.coach_group_uuid for subsequent /coach posts.
 *
 * Throws if RELAYER_URL is empty.
 */
export async function createGroupAsCoach(args: {
  name: string;
  members: string[];
}): Promise<CoachGroupResult> {
  const coach = getCoachKeypair();
  const messaging = getMessaging(coach);
  if (!messaging.enabled) {
    throw new Error('[messaging] disabled: set RELAYER_URL to enable');
  }
  const uuid = newGroupUuid();
  const { digest } = await messaging.createAndShareGroup({
    signer: coach,
    name: args.name,
    uuid,
    initialMembers: args.members,
  });
  return { uuid, digest };
}

/**
 * Send a message to an existing group as the Coach. Gas + storage paid by
 * the Coach keypair. Useful for "Coach response posted to group" flows
 * triggered by webhook / cron.
 */
export async function sendMessageAsCoach(args: {
  groupUuid: string;
  text: string;
}): Promise<{ messageId: string }> {
  const coach = getCoachKeypair();
  const messaging = getMessaging(coach);
  if (!messaging.enabled) {
    throw new Error('[messaging] disabled: set RELAYER_URL to enable');
  }
  return await messaging.sendMessage({
    signer: coach,
    groupUuid: args.groupUuid,
    text: args.text,
  });
}

/**
 * Read historical messages from a group using the Coach as the read-side
 * SessionKey signer. The Coach is a member of every group it creates, so it
 * has SEAL decrypt rights on the channel's stream. The HTTP read endpoint
 * (`GET /messaging/list/:groupUuid`) calls this after enforcing membership
 * via TraderProfile.{coach_group_uuid, audit_group_uuid}.
 *
 * Throws when RELAYER_URL is empty or when the upstream SDK read fails. The
 * caller is responsible for turning those into the `{ unavailable: true }`
 * graceful-degradation response.
 */
export async function listMessagesAsCoach(
  groupUuid: string,
  limit = 50,
): Promise<{ messages: MessagingDecryptedMessage[]; hasNext: boolean }> {
  const coach = getCoachKeypair();
  const messaging = getMessaging(coach);
  if (!messaging.enabled) {
    throw new Error('[messaging] disabled: set RELAYER_URL to enable');
  }
  return await messaging.getMessages({
    signer: coach,
    groupUuid,
    limit,
  });
}
