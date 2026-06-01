/**
 * NotificationDispatcher — fans event-driven notifications out to Telegram
 * (direct bot DMs) AND to the user's Sui Stack Messaging Coach Chat group
 * (per LIGHTHOUSE.md §13.3 categories).
 *
 * Each notification is best-effort: a Telegram send failure does not block the
 * messaging send, and vice versa. Failures are logged but never thrown so the
 * EventIndexer's cursor advances regardless.
 */

import { prismaQuery } from '../lib/prisma.ts';
import { getMessaging } from '../lib/messaging.ts';
import { getCoachKeypair } from '../lib/keypairs.ts';
import { getTelegramBot } from '../lib/telegramBot.ts';

export type NotificationCategory =
  | 'trade_settled'
  | 'hedge_opened'
  | 'hedge_settled'
  | 'budget_warning'
  | 'agent_expired'
  | 'agent_revoked'
  | 'weekly_report_ready'
  | 'deposit_swept';

export interface NotificationInput {
  /// The Sui address of the affected user.
  userAddress: string;
  category: NotificationCategory;
  /// Human-readable message body.
  text: string;
  /// Optional structured context persisted alongside the notification row
  /// (e.g. tx digest, amount, oracle id). Surfaced via GET /notifications/recent.
  payload?: Record<string, unknown>;
}

/// Short human-readable title per category. Used in the persisted Notification
/// row so web clients render a header without re-parsing `text`.
function titleFor(cat: NotificationCategory): string {
  switch (cat) {
    case 'trade_settled': return 'Trade settled';
    case 'hedge_opened': return 'Hedge opened';
    case 'hedge_settled': return 'Hedge settled';
    case 'budget_warning': return 'Budget warning';
    case 'agent_expired': return 'Agent expired';
    case 'agent_revoked': return 'Agent revoked';
    case 'weekly_report_ready': return 'Weekly report ready';
    case 'deposit_swept': return 'Deposit credited';
  }
}

/// Maps category → group selector. Agent revocation goes to Audit Log; the
/// rest go to Coach Chat.
function groupFor(profile: { coach_group_uuid?: string | null; audit_group_uuid?: string | null }, cat: NotificationCategory): string | null {
  if (cat === 'agent_revoked') return profile.audit_group_uuid ?? null;
  return profile.coach_group_uuid ?? null;
}

/**
 * Dispatch a notification to the user. Best-effort across both channels.
 */
export async function dispatch(input: NotificationInput): Promise<void> {
  const profile = await prismaQuery.traderProfile.findUnique({
    where: { sui_address: input.userAddress },
    include: { telegram: true },
  });
  if (!profile) {
    console.warn(`[notify] no TraderProfile for ${input.userAddress}; dropping ${input.category}`);
    return;
  }

  // === Persist Notification row FIRST so the web SPA can surface it even if
  // the Telegram/Messaging fanout below fails. Best-effort: we DO NOT block
  // delivery on a DB write failure (e.g. before db:push has been run after a
  // schema change). ===
  try {
    await prismaQuery.notification.create({
      data: {
        trader_profile_id: profile.id,
        kind: input.category,
        title: titleFor(input.category),
        body: input.text,
        payload: (input.payload ?? null) as never,
      },
    });
  } catch (e) {
    console.error('[notify] DB persist failed (non-fatal):', (e as Error).message);
  }

  // === Telegram DM ===
  if (profile.telegram) {
    try {
      const bot = getTelegramBot();
      if (bot.enabled) {
        // We don't have the raw telegram_user_id (only its hash). The bot needs
        // the raw chat id to DM, so we store that separately on TelegramUser
        // when the user first /start's the bot. For now we degrade silently.
        const tg = profile.telegram as unknown as { telegram_chat_id?: string | null };
        if (tg.telegram_chat_id) {
          await bot.sendMessage(Number(tg.telegram_chat_id), formatTelegramBody(input));
        }
      }
    } catch (e) {
      console.error('[notify] telegram send failed:', (e as Error).message);
    }
  }

  // === Sui Stack Messaging group ===
  const groupUuid = groupFor(
    profile as unknown as { coach_group_uuid?: string | null; audit_group_uuid?: string | null },
    input.category,
  );
  if (groupUuid) {
    try {
      const msg = getMessaging(getCoachKeypair());
      if (msg.enabled) {
        await msg.sendMessage({
          signer: getCoachKeypair(),
          groupUuid,
          text: input.text,
        });
      }
    } catch (e) {
      console.error('[notify] messaging send failed:', (e as Error).message);
    }
  }
}

function formatTelegramBody(input: NotificationInput): string {
  const prefix = {
    trade_settled: '✅ Trade settled',
    hedge_opened: '🎯 Hedge opened',
    hedge_settled: '🏁 Hedge settled',
    budget_warning: '⚠️ Budget warning',
    agent_expired: '⏰ Agent expired',
    agent_revoked: '🛑 Agent revoked',
    weekly_report_ready: '📊 Weekly report ready',
    deposit_swept: '💰 Deposit credited',
  }[input.category];
  return `${prefix}\n\n${input.text}`;
}
