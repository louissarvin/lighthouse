/**
 * predictSettlementWorker — polls oracle objects for settled binary markets
 * and notifies users of the outcome (WIN → claim CTA; LOSS → condolence).
 *
 * Why a worker (vs. event-driven): the on-chain predict package does not emit
 * a Settled event we can index, but the oracle object updates its
 * `settlement_price` field when the market expires. Polling every 2 minutes is
 * cheap (we only query oracles for OPEN HedgePosition rows, deduped per cron
 * tick) and gives a worst-case 2 min notification latency, which is acceptable
 * for binary options with hourly expiries.
 *
 * SECURITY / SAFETY:
 *   - `isRunning` flag prevents overlapping cron ticks from racing on the same
 *     position (would otherwise double-notify the user).
 *   - We only ever flip status `open` → `settled` here; the user has to opt-in
 *     to the redeem PTB to actually move funds. No silent on-chain writes.
 *   - All RPC reads use REQUEST_TIMEOUT_MS AbortSignal — a hung Sui RPC won't
 *     deadlock the cron tick. Timeout is configurable via env var.
 *   - We persist `settled_at` before sending the Telegram message so that even
 *     if the bot send fails (network blip / bot disabled), we won't re-notify
 *     on the next tick. The OAuth claim link is short-lived (5 min) but the
 *     user can always call /predict to surface positions again.
 */

import cron from 'node-cron';

import { REQUEST_TIMEOUT_MS, SUI_RPC_URL } from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { getTelegramBot } from '../lib/telegramBot.ts';
import { buildTelegramOAuthFlow } from '../lib/zklogin.ts';

let isRunning = false;

interface OracleObjectResponse {
  result?: {
    data?: {
      content?: {
        fields?: {
          settlement_price?: string | number | null;
          expiry?: string | number;
        };
      };
      owner?: { Shared?: { initial_shared_version?: number | string } } | string;
    };
  };
}

async function checkSettledPositions(): Promise<void> {
  if (isRunning) {
    console.log('[settlement] previous run still active, skipping');
    return;
  }
  isRunning = true;
  try {
    const positions = await prismaQuery.hedgePosition.findMany({
      where: { status: 'open', deleted_at: null },
      include: {
        trader_profile: {
          include: { telegram: true },
        },
      },
    });

    for (const pos of positions) {
      try {
        // ─── 1. Query oracle for settlement_price ─────────────────────────
        const resp = await fetch(SUI_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_getObject',
            params: [pos.oracle_id, { showContent: true, showOwner: true }],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!resp.ok) continue;
        const data = (await resp.json()) as OracleObjectResponse;
        const fields = data?.result?.data?.content?.fields;
        if (!fields) continue;

        // Not settled yet — oracle still holds null in settlement_price.
        if (
          fields.settlement_price === null ||
          fields.settlement_price === undefined
        ) {
          continue;
        }

        const settlementPrice = BigInt(fields.settlement_price);
        const strike = pos.strike;
        const won = pos.is_up
          ? settlementPrice > strike
          : settlementPrice < strike;

        // ─── 2. Format display values (USD with 9-decimal scale) ──────────
        const strikeUsd = (Number(strike) / 1e9).toFixed(2);
        const settlementUsd = (Number(settlementPrice) / 1e9).toFixed(2);
        const direction = pos.is_up ? 'UP' : 'DOWN';
        const dirEmoji = pos.is_up ? '📈' : '📉';

        // ─── 1.5. Verify mint tx succeeded on-chain before treating as win ────────
        // Non-fatal for LOSS (doesn't matter) but critical for WIN to prevent
        // false "Prediction Won!" notifications for phantom positions.
        if (won && pos.tx_digest) {
          let mintTxVerified = false;
          try {
            const txCheckResp = await fetch(SUI_RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sui_getTransactionBlock',
                params: [pos.tx_digest, { showEffects: true }],
              }),
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (txCheckResp.ok) {
              const txData = (await txCheckResp.json()) as {
                result?: { effects?: { status?: { status?: string } } };
              };
              const txStatus = txData?.result?.effects?.status?.status;
              if (txStatus === 'success') {
                mintTxVerified = true;
              } else {
                console.warn(
                  `[settlement] position ${pos.id} mint tx ${pos.tx_digest} status=${txStatus ?? 'unknown'} — phantom position, marking lost`,
                );
              }
            }
          } catch (verifyErr) {
            // RPC call itself failed — be conservative: don't notify but don't delete
            console.warn(
              `[settlement] position ${pos.id} mint tx verify RPC failed (skipping this tick): ${(verifyErr as Error).message}`,
            );
            continue; // Try again on next 2-min tick
          }

          if (!mintTxVerified) {
            // Mint tx failed on-chain — this is a phantom position.
            // Mark as 'lost' so it never shows as claimable.
            // No WIN notification sent.
            await prismaQuery.hedgePosition.update({
              where: { id: pos.id },
              data: {
                status: 'lost',
                settled_at: new Date(),
              },
            });
            console.log(
              `[settlement] position ${pos.id} phantom: mint tx failed on-chain, status updated to lost`,
            );
            continue;
          }
        }

        // ─── 3. Flip DB status BEFORE notifying (idempotency) ─────────────
        // Won positions → 'settled' (claim available).
        // Lost positions → 'lost'  (no claim button, DUSDC gone to vault).
        // Separating the two prevents /positions from showing lost bets as
        // claimable and prevents the phantom-cleanup code from eating real rows.
        await prismaQuery.hedgePosition.update({
          where: { id: pos.id },
          data: {
            status: won ? 'settled' : 'lost',
            settled_at: new Date(),
          },
        });

        const chatId = pos.trader_profile?.telegram?.telegram_chat_id;
        if (!chatId) {
          console.log(
            `[settlement] position ${pos.id} settled (${won ? 'WIN' : 'LOSS'}) but no chat_id — DB updated, skipping notify`,
          );
          continue;
        }
        const chatIdNum = Number(chatId);
        const bot = getTelegramBot();
        if (!bot.enabled) {
          console.log(
            `[settlement] position ${pos.id} settled (${won ? 'WIN' : 'LOSS'}) but bot disabled — DB updated, skipping notify`,
          );
          continue;
        }

        if (won) {
          // ─── 4a. Build redeem OAuth URL so the user can claim winnings ──
          const tgHash =
            pos.trader_profile?.telegram?.telegram_user_id_hash ?? '';
          const ownerOwner = data?.result?.data?.owner;
          const oracleIsv =
            ownerOwner && typeof ownerOwner !== 'string'
              ? Number(ownerOwner.Shared?.initial_shared_version ?? 0)
              : 0;

          let claimUrl: string | null = null;
          try {
            // Prefer expiry_ms stored at mint time; fall back to the oracle's
            // on-chain `expiry` field as a safety net for old rows that were
            // created before this column was added.
            const expiryMsStr =
              pos.expiry_ms?.toString() ?? fields.expiry?.toString() ?? '0';

            if (tgHash && pos.predict_id) {
              const flow = await buildTelegramOAuthFlow(tgHash, {
                action: 'predict_redeem',
                // 30 minutes — enough for the full Google OAuth flow.
                ttlMs: 30 * 60 * 1000,
                action_meta: {
                  traderProfileId: pos.trader_profile_id,
                  predictObjectId: pos.predict_id,
                  oracleObjectId: pos.oracle_id,
                  oracleInitialSharedVersion: oracleIsv,
                  expiryMs: expiryMsStr,
                  strike: pos.strike.toString(),
                  isUp: pos.is_up,
                  quantity: pos.quantity.toString(),
                },
              });
              claimUrl = flow.oauthUrl;
            }
          } catch (e) {
            console.warn(
              `[settlement] redeem OAuth build failed for ${pos.id}:`,
              (e as Error).message,
            );
          }

          const betDusdc = (Number(pos.quantity) / 1_000_000).toFixed(2);
          // The protocol's keeper bot auto-redeems winning positions the moment
          // the oracle settles, so the DUSDC is usually already in the
          // PredictManager before this notification fires. The claim link below
          // is a fallback in case the keeper hasn't run yet — if clicking it
          // shows "already credited", the winnings are in /balance.
          const claimLine = claimUrl
            ? `\n\nYour payout is usually auto-credited instantly. If you want to verify or trigger manually:\n${claimUrl}`
            : `\n\nCheck /balance — your payout may already be auto-credited to your PredictManager.`;

          await bot.sendMessage(
            chatIdNum,
            `🎉 Prediction Won!\n\n` +
              `${dirEmoji} ${direction} on BTC/USD\n` +
              `Strike: $${strikeUsd}\n` +
              `Settlement: $${settlementUsd}\n` +
              `🏆 Payout: ${betDusdc} DUSDC` +
              claimLine,
          );
        } else {
          await bot.sendMessage(
            chatIdNum,
            `📊 Prediction Settled\n\n` +
              `${dirEmoji} ${direction} on BTC/USD — expired\n` +
              `Strike: $${strikeUsd}\n` +
              `Settlement: $${settlementUsd}\n\n` +
              `The market moved against your position. Better luck next time!\n` +
              `Use /predict to place another.`,
          );
        }

        console.log(
          `[settlement] position ${pos.id} settled: ${won ? 'WIN' : 'LOSS'} (strike=$${strikeUsd} settle=$${settlementUsd})`,
        );

        // ─── MemWal write-back (non-fatal) ────────────────────────────────
        try {
          const memProfile = pos.trader_profile;
          if (memProfile?.memwal_account_id && memProfile?.memwal_delegate_key_encrypted) {
            const { envelopeDecrypt } = await import('../lib/envelope.ts');
            const { analyzeAndRemember, NAMESPACES } = await import('../lib/memwal.ts');
            const delegateKey = envelopeDecrypt(memProfile.id, memProfile.memwal_delegate_key_encrypted);
            const account = { delegateKey, accountId: memProfile.memwal_account_id };
            const betDusdc = (Number(pos.quantity) / 1_000_000).toFixed(2);
            const outcome = won ? 'WON' : 'LOST';
            const narrative =
              `Binary prediction ${outcome}: BTC/USD ${direction} at strike $${strikeUsd}. ` +
              `Settlement price: $${settlementUsd}. Payout: ${betDusdc} DUSDC. ` +
              `Date: ${new Date().toISOString()}.`;
            analyzeAndRemember(account, narrative, NAMESPACES.trades, new Date()).catch((e: unknown) => {
              console.warn(`[settlement] ${pos.id} memwal trades async write failed:`, (e as Error).message);
            });
            if (!won) {
              const lesson =
                `Lesson from loss: Predicted BTC/USD would go ${direction} from $${strikeUsd} ` +
                `but it settled at $${settlementUsd}. ` +
                `Market moved against the position. Consider price momentum and macro context before the next bet.`;
              analyzeAndRemember(account, lesson, NAMESPACES.lessonsLearned, new Date()).catch((e: unknown) => {
                console.warn(`[settlement] ${pos.id} memwal lessons async write failed:`, (e as Error).message);
              });
            }
          }
        } catch (memErr) {
          console.warn(
            `[settlement] position ${pos.id} memwal write-back failed (non-fatal):`,
            (memErr as Error).message,
          );
        }
      } catch (e) {
        // Per-position failure must not poison the whole tick.
        console.warn(
          `[settlement] position ${pos.id} error:`,
          (e as Error).message,
        );
      }
    }
  } catch (e) {
    console.error('[settlement] tick failed:', (e as Error).message);
  } finally {
    isRunning = false;
  }
}

export function startPredictSettlementWorker(): void {
  console.log('[settlement] predict settlement worker scheduled (every 2 min)');
  cron.schedule('*/2 * * * *', () => void checkSettledPositions());
  // Run immediately on boot so positions that already settled get notified.
  void checkSettledPositions();
}
