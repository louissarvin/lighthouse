/**
 * Onboarding orchestration.
 *
 * Two ceremonies (LIGHTHOUSE.md §15.2 step 11–14):
 *   1. After zkLogin succeeds, bind telegram_user_id_hash <-> sui_address
 *      and create/upsert a TraderProfile row.
 *   2. Pre-generate Sui Stack Messaging Coach Chat + Audit Log group UUIDs so
 *      the dispatcher has somewhere to deliver notifications. Actual
 *      `createAndShareGroup` is signed by the USER (their keypair owns the
 *      group), so this service only RESERVES uuids; the frontend issues the
 *      Move call.
 */

import { prismaQuery } from '../lib/prisma.ts';
import { newGroupUuid } from '../lib/messaging.ts';

export interface BindArgs {
  /// Hashed Telegram user id (peppered SHA-256).
  telegramUserIdHash: string;
  /// Raw Telegram chat id, for direct DMs (not PII once user starts the bot).
  telegramChatId?: number;
  /// Sui address derived from zkLogin.
  suiAddress: string;
  /// On-chain TraderProfile shared object ID — set after first Move call.
  profileObjectId?: string;
  /// Optional Telegram @handle for friendly display.
  telegramUsername?: string;
}

export interface BindResult {
  traderProfileId: string;
  coachGroupUuid: string;
  auditGroupUuid: string;
  created: boolean;
}

/**
 * Idempotent bind. Creates a TraderProfile if missing, attaches the
 * TelegramUser if missing, and reserves messaging group UUIDs.
 */
export async function bindTelegramToSuiAddress(args: BindArgs): Promise<BindResult> {
  // Look up by sui_address first; profile is the authoritative anchor.
  const existing = await prismaQuery.traderProfile.findUnique({
    where: { sui_address: args.suiAddress },
    include: { telegram: true },
  });

  // The `TelegramUser` table is also used as a generic "surface binding"
  // row for web-origin OAuth flows (synthetic hash prefix `web::<nanoid>`).
  // For real telegram bindings (raw_hash, no prefix) we need to ignore any
  // synthetic web-origin row so the same TraderProfile can host both a web
  // session AND a real telegram binding for the same Sui address.
  const isIncomingTelegram = !args.telegramUserIdHash.startsWith('web::');

  if (existing) {
    const existingIsWebPlaceholder =
      existing.telegram?.telegram_user_id_hash.startsWith('web::') ?? false;

    if (!existing.telegram) {
      // No binding row yet — create one for this surface.
      await prismaQuery.telegramUser.create({
        data: {
          telegram_user_id_hash: args.telegramUserIdHash,
          telegram_chat_id: args.telegramChatId ? BigInt(args.telegramChatId) : null,
          telegram_username: args.telegramUsername ?? null,
          trader_profile_id: existing.id,
        },
      });
    } else if (isIncomingTelegram && existingIsWebPlaceholder) {
      // Real telegram binding incoming, but the row is currently a web
      // placeholder. Promote the row to the real telegram identity in place
      // (the `trader_profile_id @unique` constraint prevents inserting a
      // second row for this profile, so we update the existing row).
      await prismaQuery.telegramUser.update({
        where: { id: existing.telegram.id },
        data: {
          telegram_user_id_hash: args.telegramUserIdHash,
          telegram_chat_id: args.telegramChatId ? BigInt(args.telegramChatId) : null,
          telegram_username: args.telegramUsername ?? null,
        },
      });
    } else if (args.telegramChatId && !existing.telegram.telegram_chat_id) {
      await prismaQuery.telegramUser.update({
        where: { id: existing.telegram.id },
        data: { telegram_chat_id: BigInt(args.telegramChatId) },
      });
    }
    return {
      traderProfileId: existing.id,
      coachGroupUuid: existing.coach_group_uuid ?? '',
      auditGroupUuid: existing.audit_group_uuid ?? '',
      created: false,
    };
  }

  // New user — reserve group UUIDs up front.
  const coachUuid = newGroupUuid();
  const auditUuid = newGroupUuid();

  const profile = await prismaQuery.traderProfile.create({
    data: {
      sui_address: args.suiAddress,
      // null until the on-chain trader_profile::create PTB is signed and
      // recordProfileObjectId() backfills it. Empty string was previously
      // used as a sentinel but collides with the @unique constraint on the
      // second new user.
      profile_object_id: args.profileObjectId ?? null,
      coach_group_uuid: coachUuid,
      audit_group_uuid: auditUuid,
      telegram: {
        create: {
          telegram_user_id_hash: args.telegramUserIdHash,
          telegram_chat_id: args.telegramChatId ? BigInt(args.telegramChatId) : null,
          telegram_username: args.telegramUsername ?? null,
        },
      },
    },
  });

  return {
    traderProfileId: profile.id,
    coachGroupUuid: coachUuid,
    auditGroupUuid: auditUuid,
    created: true,
  };
}

/**
 * Mark the on-chain profile object id once the user signs the
 * `trader_profile::create + share` PTB. Idempotent.
 */
export async function recordProfileObjectId(
  suiAddress: string,
  profileObjectId: string,
): Promise<void> {
  await prismaQuery.traderProfile.update({
    where: { sui_address: suiAddress },
    data: { profile_object_id: profileObjectId },
  });
}
