/**
 * GET /oauth/callback?state=<nonce>&code=<google_code>
 *
 * Completes the zkLogin flow that started via /auth/telegram/verify.
 *
 * Flow (LIGHTHOUSE.md §15.2 step 8-11):
 *   1. Validate `state` against the OAuthNonce row (single-use, 5-min TTL).
 *   2. Exchange `code` → Google id_token via `oauth2.googleapis.com/token`.
 *   3. Derive Sui address via Enoki `getZkLogin({ jwt })`.
 *   4. Bind to TraderProfile via OnboardingService.
 *   5. Redirect to `https://t.me/<bot>?start=zklogin_done_<nonce>`.
 *
 * SECURITY:
 *   - state is single-use; mark consumed_at on success.
 *   - reject expired nonces.
 *   - telegram_user_id_hash is the persisted PII-safe identifier.
 *
 * DEV STUB: if the caller passes `sui_address` directly (no `code`), we skip
 * Google exchange — useful for local testing before GOOGLE_CLIENT_ID is
 * provisioned. Logged in dev. Returns 501 in production.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';

import {
  IS_DEV,
  JWT_EXPIRES_IN,
  JWT_SECRET,
  OAUTH_CALLBACK,
  WEB_BASE_URL,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { deriveSuiAddressFromJwt, exchangeGoogleCode } from '../lib/zklogin.ts';
import {
  handleError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface CallbackQuery {
  state?: string;
  code?: string;
  /// Dev-only escape hatch.
  sui_address?: string;
}

export const oauthRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as CallbackQuery;
    if (!q?.state) return handleValidationError(reply, ['state']);
    if (!q?.code && !q?.sui_address) {
      return handleValidationError(reply, ['code (or sui_address in dev)']);
    }

    // 1. Validate state.
    let nonce;
    try {
      nonce = await prismaQuery.oAuthNonce.findUnique({ where: { nonce: q.state } });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
    if (!nonce) return handleError(reply, 400, 'invalid oauth state', 'OAUTH_STATE_INVALID');
    if (nonce.consumed_at) {
      return handleError(reply, 400, 'oauth state already used', 'OAUTH_STATE_REUSED');
    }
    if (nonce.expires_at.getTime() < Date.now()) {
      return handleError(reply, 400, 'oauth state expired', 'OAUTH_STATE_EXPIRED');
    }

    // 2. Derive Sui address. Keep the JWT in scope — we use it below for
    // the auto-setup-trading flow that happens during the same callback.
    let suiAddress: string;
    let userJwt: string | null = null;
    if (q.code) {
      try {
        const tokens = await exchangeGoogleCode({ code: q.code, redirectUri: OAUTH_CALLBACK });
        userJwt = tokens.idToken;
        suiAddress = await deriveSuiAddressFromJwt(tokens.idToken);
      } catch (e) {
        return handleError(reply, 502, 'oauth/zkLogin derivation failed', 'OAUTH_DERIVE_FAILED', e as Error);
      }
    } else {
      // sui_address path (dev only).
      if (!IS_DEV) {
        return handleError(
          reply,
          501,
          'sui_address bypass is dev-only; provide code',
          'OAUTH_CODE_REQUIRED',
        );
      }
      suiAddress = q.sui_address!;
    }

    try {
      const { bindTelegramToSuiAddress } = await import('../services/OnboardingService.ts');
      const result = await bindTelegramToSuiAddress({
        telegramUserIdHash: nonce.telegram_user_id_hash,
        suiAddress,
      });

      await prismaQuery.oAuthNonce.update({
        where: { nonce: q.state },
        data: { consumed_at: new Date() },
      });

      // ─── Branch on nonce.origin ─────────────────────────────────────────
      // origin='web' → mint a one-shot WebAuthHandoff token, redirect to the
      // SPA's /oauth-finish page. That page calls /auth/web/set-cookie which
      // burns the token in exchange for an httpOnly session cookie. JWT NEVER
      // sits in the URL longer than one navigation hop.
      if (nonce.origin === 'web') {
        // ─── Pre-handoff action dispatch (web origin) ─────────────────────
        // Mirrors the telegram branch: if the nonce carries an `action`, we
        // run the server-side bootstrap with the freshly-issued JWT BEFORE
        // minting the WebAuthHandoff token. The web SPA can't reliably sign
        // these PTBs client-side (Enoki path has reliability issues / MemWal
        // package isn't on Enoki's allowlist), so the backend does it inline.
        //
        // bootstrapMemWalViaZkLogin is idempotent: if `memwal_account_id` is
        // already set on the profile it early-returns without touching chain.
        if (nonce.action === 'memwal_setup' && result.traderProfileId && userJwt && nonce.zklogin_state) {
          try {
            const { bootstrapMemWalViaZkLogin } = await import('../services/MemWalBootstrap.ts');
            const r = await bootstrapMemWalViaZkLogin({
              profileId: result.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
            });
            console.log(
              `[oauth/web/memwal_setup] success for ${suiAddress.slice(0, 10)}… ` +
                `account=${r.accountId.slice(0, 10)}…`,
            );
          } catch (e) {
            const err = e as Error;
            console.error(
              `[oauth/web/memwal_setup] failed for ${suiAddress.slice(0, 10)}…`,
              err,
            );
            const errorBase = nonce.web_redirect_uri ?? `${WEB_BASE_URL}/oauth-finish`;
            const errUrl = new URL(errorBase);
            errUrl.searchParams.set('error', 'memwal_failed');
            errUrl.searchParams.set('detail', String(err.message ?? 'unknown error').slice(0, 240));
            return reply.code(302).redirect(errUrl.toString());
          }
        }

        const token = jwt.sign(
          {
            sub: suiAddress,
            kind: 'zklogin',
            sui_address: suiAddress,
            profile_id: result.traderProfileId,
          },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
        );

        const handoffToken = nanoid(40);
        const handoffExpiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 min
        await prismaQuery.webAuthHandoff.create({
          data: {
            handoff_token: handoffToken,
            jwt: token,
            sui_address: suiAddress,
            expires_at: handoffExpiresAt,
          },
        });

        const redirectBase = nonce.web_redirect_uri ?? `${WEB_BASE_URL}/oauth-finish`;
        const url = new URL(redirectBase);
        url.searchParams.set('handoff', handoffToken);
        url.searchParams.set('addr', suiAddress);
        return reply.code(302).redirect(url.toString());
      }

      // ─── Branch on nonce.action (Telegram flows) ───────────────────────
      // 'deposit' → run DepositService instead of the onboarding bootstrap.
      // null/undefined/'onboard' → existing auto-setup-trading flow.
      const action = nonce.action ?? 'onboard';

      const botUsername = process.env.TELEGRAM_BOT_USERNAME;

      // ─── Predict setup: create_manager + DUSDC deposit (two PTBs) ─────
      if (action === 'predict_setup') {
        let predictOutcome: { ok: true; digest: string; predictManagerId: string }
          | { ok: false; message: string }
          | null = null;
        if (userJwt && nonce.zklogin_state && nonce.action_meta) {
          try {
            const meta = nonce.action_meta as {
              traderProfileId?: string;
              amountRaw?: string;
            };
            if (!meta.traderProfileId || !meta.amountRaw) {
              throw new Error('predict_setup action_meta missing traderProfileId or amountRaw');
            }
            const amountRaw = BigInt(meta.amountRaw);
            const { setupPredictViaZkLogin } = await import('../services/PredictService.ts');
            const r = await setupPredictViaZkLogin({
              traderProfileId: meta.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
              amountRaw,
            });
            predictOutcome = {
              ok: true,
              digest: r.digest,
              predictManagerId: r.predictManagerId,
            };
            console.log(
              `[oauth/predict_setup] success for ${suiAddress.slice(0, 10)}… digest=${r.digest.slice(0, 12)}…`,
            );

            // Best-effort: push setup confirmation directly to the user's Telegram chat.
            try {
              const tgUser = await prismaQuery.telegramUser.findFirst({
                where: { telegram_user_id_hash: nonce.telegram_user_id_hash },
                select: { telegram_chat_id: true },
              });
              if (tgUser?.telegram_chat_id) {
                const { getTelegramBot } = await import('../lib/telegramBot.ts');
                await getTelegramBot().sendMessage(
                  Number(tgUser.telegram_chat_id),
                  `✅ Your DeepBook Predict account is ready!\n\n` +
                  `Your PredictManager has been created and funded with DUSDC.\n\n` +
                  `Use /predict to see live BTC markets and place your first prediction.`,
                );
              }
            } catch (notifyErr) {
              console.warn('[oauth/predict_setup] push notification failed (non-fatal):', (notifyErr as Error).message);
            }
          } catch (e) {
            const err = e as Error & { cause?: Error; errors?: { code?: string; message?: string }[] };
            const cause = err.cause?.message ?? '';
            const enokiErrors = err.errors?.map((x) => `${x.code}: ${x.message}`).join('; ') ?? '';
            const detail = enokiErrors || cause || err.message || 'unknown error';
            predictOutcome = { ok: false, message: detail };
            console.error(
              `[oauth/predict_setup] failed for ${suiAddress.slice(0, 10)}…\n` +
              `  message: ${err.message}\n` +
              `  cause:   ${cause}\n` +
              `  enoki:   ${enokiErrors}\n`,
              err,
            );
          }
        } else {
          predictOutcome = {
            ok: false,
            message: 'Missing JWT, zklogin state, or action_meta on nonce',
          };
        }

        if (botUsername) {
          const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
          const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
          const html = renderPredictHtml({
            mode: 'setup',
            outcome: predictOutcome,
            botUsername,
            tgDeep,
            tgWeb,
          });
          return reply.code(200).type('text/html; charset=utf-8').send(html);
        }
        return reply.code(200).send({
          success: predictOutcome?.ok === true,
          error: predictOutcome?.ok === false
            ? { code: 'PREDICT_SETUP_FAILED', message: predictOutcome.message }
            : null,
          data: predictOutcome?.ok
            ? { digest: predictOutcome.digest, predictManagerId: predictOutcome.predictManagerId }
            : null,
        });
      }

      // ─── Predict mint: place a binary prediction via predict::mint ────
      if (action === 'predict_mint') {
        let predictOutcome: { ok: true; digest: string }
          | { ok: false; message: string }
          | null = null;
        if (userJwt && nonce.zklogin_state && nonce.action_meta) {
          try {
            const meta = nonce.action_meta as {
              traderProfileId?: string;
              predictObjectId?: string;
              oracleObjectId?: string;
              oracleInitialSharedVersion?: number;
              expiryMs?: string;
              strike?: string;
              isUp?: boolean;
              quantity?: string;
            };
            if (
              !meta.traderProfileId ||
              !meta.predictObjectId ||
              !meta.oracleObjectId ||
              meta.oracleInitialSharedVersion === undefined ||
              !meta.expiryMs ||
              !meta.strike ||
              meta.isUp === undefined ||
              !meta.quantity
            ) {
              throw new Error('predict_mint action_meta missing required fields');
            }
            const { mintPredictViaZkLogin } = await import('../services/PredictService.ts');
            const r = await mintPredictViaZkLogin({
              traderProfileId: meta.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
              predictObjectId: meta.predictObjectId,
              oracleObjectId: meta.oracleObjectId,
              oracleInitialSharedVersion: Number(meta.oracleInitialSharedVersion),
              expiryMs: BigInt(meta.expiryMs),
              strike: BigInt(meta.strike),
              isUp: Boolean(meta.isUp),
              quantity: BigInt(meta.quantity),
            });
            predictOutcome = { ok: true, digest: r.digest };
            console.log(
              `[oauth/predict_mint] success for ${suiAddress.slice(0, 10)}… digest=${r.digest.slice(0, 12)}…`,
            );

            // Best-effort: push prediction confirmation directly to the user's Telegram chat.
            try {
              const tgUser = await prismaQuery.telegramUser.findFirst({
                where: { telegram_user_id_hash: nonce.telegram_user_id_hash },
                select: { telegram_chat_id: true },
              });
              if (tgUser?.telegram_chat_id) {
                const { getTelegramBot } = await import('../lib/telegramBot.ts');
                const chatId = Number(tgUser.telegram_chat_id);
                const isUp = Boolean(meta.isUp);
                const strikeUsd = (Number(BigInt(meta.strike!)) / 1e9).toLocaleString();
                const expiryDate = new Date(Number(meta.expiryMs));
                const expiryStr = expiryDate.toUTCString().replace('GMT', 'UTC').slice(5, 22);
                const txUrl = `https://suiscan.xyz/testnet/tx/${r.digest}`;
                await getTelegramBot().sendMessage(
                  chatId,
                  `🎯 Prediction placed on-chain!\n\n` +
                  `${isUp ? '📈 UP' : '📉 DOWN'} on BTC/USD\n` +
                  `💰 Strike: $${strikeUsd}\n` +
                  `⏱ Expires: ${expiryStr} UTC\n` +
                  `🏆 Payout if wins: 10 DUSDC\n\n` +
                  `TX: ${txUrl}\n\n` +
                  `Use /predict to place another or track positions.`,
                );
              }
            } catch (notifyErr) {
              console.warn('[oauth/predict_mint] push notification failed (non-fatal):', (notifyErr as Error).message);
            }

            // ─── MemWal write-back (non-fatal) ─────────────────────────────
            try {
              const memProfile = await prismaQuery.traderProfile.findUnique({
                where: { id: meta.traderProfileId! },
                select: { id: true, memwal_account_id: true, memwal_delegate_key_encrypted: true },
              });
              if (memProfile?.memwal_account_id && memProfile?.memwal_delegate_key_encrypted) {
                const { envelopeDecrypt } = await import('../lib/envelope.ts');
                const { analyzeAndRemember, NAMESPACES } = await import('../lib/memwal.ts');
                const delegateKey = envelopeDecrypt(memProfile.id, memProfile.memwal_delegate_key_encrypted);
                const account = { delegateKey, accountId: memProfile.memwal_account_id };
                const direction = Boolean(meta.isUp) ? 'UP' : 'DOWN';
                const strikeUsd = (Number(BigInt(meta.strike!)) / 1e9).toFixed(2);
                const expiryDate = new Date(Number(meta.expiryMs)).toISOString();
                const narrative =
                  `Placed binary prediction: BTC/USD ${direction} at strike $${strikeUsd}. ` +
                  `Payout if wins: 10 DUSDC (cost ~50% at market probability). Expiry: ${expiryDate}. TX: ${r.digest}. ` +
                  `Date: ${new Date().toISOString()}.`;
                analyzeAndRemember(account, narrative, NAMESPACES.trades, new Date()).catch((e: unknown) => {
                  console.warn('[oauth/predict_mint] memwal async write failed:', (e as Error).message);
                });
              }
            } catch (memErr) {
              console.warn('[oauth/predict_mint] memwal write-back failed (non-fatal):', (memErr as Error).message);
            }
          } catch (e) {
            const err = e as Error & { cause?: Error; errors?: { code?: string; message?: string }[] };
            const cause = err.cause?.message ?? '';
            const enokiErrors = err.errors?.map((x) => `${x.code}: ${x.message}`).join('; ') ?? '';
            const detail = enokiErrors || cause || err.message || 'unknown error';
            predictOutcome = { ok: false, message: detail };
            console.error(
              `[oauth/predict_mint] failed for ${suiAddress.slice(0, 10)}…\n` +
              `  message: ${err.message}\n` +
              `  cause:   ${cause}\n` +
              `  enoki:   ${enokiErrors}\n`,
              err,
            );
          }
        } else {
          predictOutcome = {
            ok: false,
            message: 'Missing JWT, zklogin state, or action_meta on nonce',
          };
        }

        if (botUsername) {
          const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
          const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
          const html = renderPredictHtml({
            mode: 'mint',
            outcome: predictOutcome,
            botUsername,
            tgDeep,
            tgWeb,
          });
          return reply.code(200).type('text/html; charset=utf-8').send(html);
        }
        return reply.code(200).send({
          success: predictOutcome?.ok === true,
          error: predictOutcome?.ok === false
            ? { code: 'PREDICT_MINT_FAILED', message: predictOutcome.message }
            : null,
          data: predictOutcome?.ok ? { digest: predictOutcome.digest } : null,
        });
      }

      // ─── Predict redeem: claim winnings on a settled MarketKey ─────────
      if (action === 'predict_redeem') {
        let predictOutcome: { ok: true; digest: string }
          | { ok: false; message: string }
          | null = null;
        if (userJwt && nonce.zklogin_state && nonce.action_meta) {
          try {
            const meta = nonce.action_meta as {
              traderProfileId?: string;
              predictObjectId?: string;
              oracleObjectId?: string;
              oracleInitialSharedVersion?: number;
              expiryMs?: string;
              strike?: string;
              isUp?: boolean;
              quantity?: string;
            };
            if (
              !meta.traderProfileId ||
              !meta.predictObjectId ||
              !meta.oracleObjectId ||
              meta.oracleInitialSharedVersion === undefined ||
              !meta.expiryMs ||
              !meta.strike ||
              meta.isUp === undefined ||
              !meta.quantity
            ) {
              throw new Error('predict_redeem action_meta missing required fields');
            }
            const { redeemPredictViaZkLogin } = await import('../services/PredictService.ts');
            const r = await redeemPredictViaZkLogin({
              traderProfileId: meta.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
              predictObjectId: meta.predictObjectId,
              oracleObjectId: meta.oracleObjectId,
              oracleInitialSharedVersion: Number(meta.oracleInitialSharedVersion),
              expiryMs: BigInt(meta.expiryMs),
              strike: BigInt(meta.strike),
              isUp: Boolean(meta.isUp),
              quantity: BigInt(meta.quantity),
            });
            predictOutcome = { ok: true, digest: r.digest };
            console.log(
              `[oauth/predict_redeem] success for ${suiAddress.slice(0, 10)}… digest=${r.digest.slice(0, 12)}…`,
            );

            // Best-effort: push redeem confirmation directly to the user's Telegram chat.
            try {
              const tgUser = await prismaQuery.telegramUser.findFirst({
                where: { telegram_user_id_hash: nonce.telegram_user_id_hash },
                select: { telegram_chat_id: true },
              });
              if (tgUser?.telegram_chat_id) {
                const { getTelegramBot } = await import('../lib/telegramBot.ts');
                const chatId = Number(tgUser.telegram_chat_id);
                const txUrl = `https://suiscan.xyz/testnet/tx/${r.digest}`;
                await getTelegramBot().sendMessage(
                  chatId,
                  `💰 Winnings claimed!\n\n` +
                  `Your payout has been credited to your PredictManager.\n\n` +
                  `TX: ${txUrl}\n\n` +
                  `Use /predict to place another or check positions.`,
                );
              }
            } catch (notifyErr) {
              console.warn('[oauth/predict_redeem] push notification failed (non-fatal):', (notifyErr as Error).message);
            }
          } catch (e) {
            const err = e as Error & { cause?: Error; errors?: { code?: string; message?: string }[] };
            const cause = err.cause?.message ?? '';
            const enokiErrors = err.errors?.map((x) => `${x.code}: ${x.message}`).join('; ') ?? '';
            const detail = enokiErrors || cause || err.message || 'unknown error';
            predictOutcome = { ok: false, message: detail };
            console.error(
              `[oauth/predict_redeem] failed for ${suiAddress.slice(0, 10)}…\n` +
              `  message: ${err.message}\n` +
              `  cause:   ${cause}\n` +
              `  enoki:   ${enokiErrors}\n`,
              err,
            );

            // If the position doesn't exist on-chain, two cases:
            //
            // A. KEEPER AUTO-REDEEMED: DeepBook Predict runs a permissionless
            //    keeper that calls predict::redeem immediately when the oracle
            //    settles. The DUSDC is already credited to the PredictManager
            //    BEFORE the user clicks the claim link. In this case the DB row
            //    is in status='settled' (settlement worker confirmed the mint tx
            //    on-chain before marking it settled), and the user's balance has
            //    already increased. We mark it 'redeemed' and show success.
            //
            // B. PHANTOM MINT: The mint tx itself failed on-chain. Settlement
            //    worker should catch these now (Step 1.5), but as a safety net
            //    we soft-delete any remaining phantom rows here.
            if ((err.message ?? '').includes('No claimable position found on-chain')) {
              try {
                const m = nonce.action_meta as {
                  traderProfileId?: string;
                  oracleObjectId?: string;
                  strike?: string;
                  isUp?: boolean;
                } | null;
                if (m?.traderProfileId && m?.oracleObjectId) {
                  // Check for settled rows (keeper case) vs no rows (phantom case).
                  const settledRows = await prismaQuery.hedgePosition.findMany({
                    where: {
                      trader_profile_id: m.traderProfileId,
                      oracle_id: m.oracleObjectId,
                      status: 'settled',
                      deleted_at: null,
                    },
                    select: { id: true },
                  });

                  if (settledRows.length > 0) {
                    // Case A: keeper already credited the payout. Mark as redeemed.
                    await prismaQuery.hedgePosition.updateMany({
                      where: {
                        trader_profile_id: m.traderProfileId,
                        oracle_id: m.oracleObjectId,
                        status: 'settled',
                        deleted_at: null,
                      },
                      data: { status: 'redeemed', settled_at: new Date() },
                    });
                    // Override outcome to success — user already got paid.
                    predictOutcome = { ok: true, digest: 'auto-credited' };
                    console.log(
                      `[oauth/predict_redeem] keeper auto-redeemed position for profile=${m.traderProfileId} oracle=${m.oracleObjectId.slice(0, 10)}… — marked redeemed, showing success`,
                    );

                    // Push auto-credit notification to Telegram.
                    try {
                      const tgUser = await prismaQuery.telegramUser.findFirst({
                        where: { telegram_user_id_hash: nonce.telegram_user_id_hash },
                        select: { telegram_chat_id: true },
                      });
                      if (tgUser?.telegram_chat_id) {
                        const { getTelegramBot } = await import('../lib/telegramBot.ts');
                        await getTelegramBot().sendMessage(
                          Number(tgUser.telegram_chat_id),
                          `💰 Winnings already in your PredictManager!\n\n` +
                          `The protocol's keeper auto-credited your payout the moment the oracle settled.\n\n` +
                          `Use /balance to confirm your updated DUSDC balance.`,
                        );
                      }
                    } catch (notifyErr) {
                      console.warn('[oauth/predict_redeem] auto-credit notify failed (non-fatal):', (notifyErr as Error).message);
                    }
                  } else {
                    // Case B: no settled rows → phantom mint. Soft-delete any stale rows.
                    await prismaQuery.hedgePosition.updateMany({
                      where: {
                        trader_profile_id: m.traderProfileId,
                        oracle_id: m.oracleObjectId,
                        status: { in: ['open', 'settled'] },
                        deleted_at: null,
                      },
                      data: { deleted_at: new Date() },
                    });
                    console.log(
                      `[oauth/predict_redeem] phantom position for profile=${m.traderProfileId} oracle=${m.oracleObjectId.slice(0, 10)}… — soft-deleted`,
                    );
                  }
                }
              } catch (cleanupErr) {
                console.warn('[oauth/predict_redeem] position cleanup failed (non-fatal):', (cleanupErr as Error).message);
              }
            }
          }
        } else {
          predictOutcome = {
            ok: false,
            message: 'Missing JWT, zklogin state, or action_meta on nonce',
          };
        }

        if (botUsername) {
          const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
          const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
          const html = renderPredictHtml({
            mode: 'redeem',
            outcome: predictOutcome,
            botUsername,
            tgDeep,
            tgWeb,
          });
          return reply.code(200).type('text/html; charset=utf-8').send(html);
        }
        return reply.code(200).send({
          success: predictOutcome?.ok === true,
          error: predictOutcome?.ok === false
            ? { code: 'PREDICT_REDEEM_FAILED', message: predictOutcome.message }
            : null,
          data: predictOutcome?.ok ? { digest: predictOutcome.digest } : null,
        });
      }

      // ─── MemWal bootstrap: create_account + add_delegate_key (two PTBs) ──
      if (action === 'memwal_setup') {
        // Server-side bootstrap — coach keypair creates the account and adds
        // the delegate key. No Enoki sponsorship or user signing required
        // (the MemWal package is not on Enoki's allowlist).
        let memwalOutcome: { ok: true; digest1: string; digest2: string; accountId: string }
          | { ok: false; message: string }
          | null = null;

        if (userJwt && nonce.zklogin_state && result.traderProfileId) {
          try {
            const { bootstrapMemWalViaZkLogin } = await import('../services/MemWalBootstrap.ts');
            const r = await bootstrapMemWalViaZkLogin({
              profileId: result.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
            });
            memwalOutcome = { ok: true, digest1: r.digest1, digest2: r.digest2, accountId: r.accountId };
            console.log(
              `[oauth/memwal_setup] success for ${suiAddress.slice(0, 10)}… ` +
                `account=${r.accountId.slice(0, 10)}…`,
            );

            // Best-effort: push confirmation to user's Telegram chat.
            try {
              const tgUser = await prismaQuery.telegramUser.findFirst({
                where: { telegram_user_id_hash: nonce.telegram_user_id_hash },
                select: { telegram_chat_id: true },
              });
              if (tgUser?.telegram_chat_id) {
                const { getTelegramBot } = await import('../lib/telegramBot.ts');
                await getTelegramBot().sendMessage(
                  Number(tgUser.telegram_chat_id),
                  `🧠 Coach memory is now active!\n\n` +
                    `Your encrypted MemWal account is live on Walrus. ` +
                    `Every trade, prediction, and coaching conversation is now remembered across sessions.\n\n` +
                    `Run /setup to tell the coach about your goals and risk profile.`,
                );
              }
            } catch (notifyErr) {
              console.warn(
                '[oauth/memwal_setup] push notification failed (non-fatal):',
                (notifyErr as Error).message,
              );
            }
          } catch (e) {
            const err = e as Error;
            memwalOutcome = { ok: false, message: err.message };
            console.error(`[oauth/memwal_setup] failed for ${suiAddress.slice(0, 10)}…`, err);
          }
        } else {
          memwalOutcome = { ok: false, message: 'Missing JWT, zklogin state, or traderProfileId' };
        }

        if (botUsername) {
          const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
          const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
          const html = renderMemwalHtml({ outcome: memwalOutcome, botUsername, tgDeep, tgWeb });
          return reply.code(200).type('text/html; charset=utf-8').send(html);
        }
        return reply.code(200).send({
          success: memwalOutcome?.ok === true,
          error: memwalOutcome?.ok === false
            ? { code: 'MEMWAL_SETUP_FAILED', message: memwalOutcome.message }
            : null,
          data: memwalOutcome?.ok
            ? {
                digest1: memwalOutcome.digest1,
                digest2: memwalOutcome.digest2,
                accountId: memwalOutcome.accountId,
              }
            : null,
        });
      }

      if (action === 'deposit') {
        let depositOutcome: { ok: true; digest: string; amountMist: bigint }
          | { ok: false; message: string }
          | null = null;
        if (userJwt && nonce.zklogin_state && nonce.action_meta) {
          try {
            const meta = nonce.action_meta as {
              amountMist?: string;
              traderProfileId?: string;
            };
            if (!meta.amountMist || !meta.traderProfileId) {
              throw new Error('deposit action_meta missing amountMist or traderProfileId');
            }
            const amountMist = BigInt(meta.amountMist);
            const { depositViaZkLogin } = await import('../services/DepositService.ts');
            const r = await depositViaZkLogin({
              traderProfileId: meta.traderProfileId,
              jwt: userJwt,
              zklState: nonce.zklogin_state as never,
              amountMist,
            });
            depositOutcome = { ok: true, digest: r.digest, amountMist };
            console.log(
              `[oauth/deposit] success for ${suiAddress.slice(0, 10)}… digest=${r.digest.slice(0, 12)}…`,
            );
          } catch (e) {
            const err = e as Error & { cause?: Error; errors?: { code?: string; message?: string }[]; status?: number };
            const cause = err.cause?.message ?? '';
            const enokiErrors = err.errors?.map((x) => `${x.code}: ${x.message}`).join('; ') ?? '';
            const detail = enokiErrors || cause || err.message || 'unknown error';
            const msg = err.message ?? 'unknown error';
            depositOutcome = { ok: false, message: detail };
            console.error(
              `[oauth/deposit] failed for ${suiAddress.slice(0, 10)}…\n` +
              `  message: ${msg}\n` +
              `  cause:   ${cause}\n` +
              `  enoki:   ${enokiErrors}\n`,
              err,
            );
          }
        } else {
          depositOutcome = {
            ok: false,
            message: 'Missing JWT, zklogin state, or action_meta on nonce',
          };
        }

        if (botUsername) {
          const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
          const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
          const html = renderDepositHtml({
            outcome: depositOutcome,
            botUsername,
            tgDeep,
            tgWeb,
          });
          return reply.code(200).type('text/html; charset=utf-8').send(html);
        }
        return reply.code(200).send({
          success: depositOutcome?.ok === true,
          error: depositOutcome?.ok === false
            ? { code: 'DEPOSIT_FAILED', message: depositOutcome.message }
            : null,
          data: depositOutcome?.ok ? { digest: depositOutcome.digest } : null,
        });
      }

      // ─── Auto-setup trading (Option B from analysis) ───────────────────
      // While the JWT + ephemeral state are still fresh, run the full
      // trading-state bootstrap so the user lands back in Telegram already
      // funded with 0.1 SUI from Coach and ready to /trade.
      //
      // Failure here is non-fatal: the binding above already succeeded;
      // the user can run /setup-trading manually later.
      let setupSummary: { dripDigest: string | null; setupDigest: string | null; bmId: string; agentId: string } | null = null;
      if (userJwt && nonce.zklogin_state && result.traderProfileId) {
        try {
          const { setupUserTrading } = await import('../services/SetupTrading.ts');
          const r = await setupUserTrading({
            traderProfileId: result.traderProfileId,
            jwt: userJwt,
            zklState: nonce.zklogin_state as never,
          });
          setupSummary = {
            dripDigest: r.dripDigest,
            setupDigest: r.setupDigest,
            bmId: r.balanceManagerId,
            agentId: r.executorAgentId,
          };
          console.log(
            `[oauth] auto-setup-trading for ${suiAddress.slice(0, 10)}…: ` +
              `BM=${r.balanceManagerId.slice(0, 10)}… Agent=${r.executorAgentId.slice(0, 10)}… ` +
              `skipped=${r.skipped}`,
          );
        } catch (e) {
          console.warn(
            `[oauth] auto-setup-trading FAILED for ${suiAddress.slice(0, 10)}…:`,
            (e as Error).message,
          );
        }
      }
      void setupSummary; // surfaced in the HTML page below
      if (botUsername) {
        // Serve an HTML page that tries the `tg://` native deep link first
        // (works on Telegram desktop + mobile, preserves the `?start=`
        // payload), falls back to `t.me` after 1.5s, and shows a manual
        // button as ultimate fallback.
        //
        // A bare 302 to `https://t.me/<bot>?start=...` lands users on
        // Telegram's web preview page; clicking "START BOT" there opens
        // the bot but DROPS the `?start=` payload — so the bot never sees
        // the zklogin_done nonce and the user gets stuck. The `tg://`
        // scheme bypasses the web preview entirely.
        const tgDeep = `tg://resolve?domain=${botUsername}&start=zklogin_done_${q.state}`;
        const tgWeb = `https://t.me/${botUsername}?start=zklogin_done_${q.state}`;
        const shortAddr = `${suiAddress.slice(0, 10)}…${suiAddress.slice(-6)}`;
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse · Signed in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         background: #0B0B0B; color: #F2EEE6; max-width: 480px; margin: 60px auto; padding: 32px;
         text-align: center; line-height: 1.5; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.5px; }
  .check { color: #10b981; font-size: 32px; margin-bottom: 16px; }
  .addr { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 13px;
          color: #7A7A7A; background: #131313; padding: 8px 12px; border-radius: 8px;
          display: inline-block; margin: 12px 0 24px; }
  p { color: #A0A0A0; margin: 12px 0; font-size: 14px; }
  .btn { display: inline-block; background: #FF6B35; color: #0B0B0B; padding: 14px 28px;
         border-radius: 999px; font-weight: 600; text-decoration: none; margin: 16px 8px;
         font-size: 15px; }
  .btn:hover { background: #FF8B5F; }
  .alt { font-size: 12px; color: #7A7A7A; }
  .alt a { color: #FF6B35; text-decoration: none; }
</style>
</head>
<body>
  <div class="check">✓</div>
  <h1>Signed in to Lighthouse</h1>
  <p>Sui address bound:</p>
  <div class="addr">${shortAddr}</div>
  <p>Returning you to @${botUsername}…</p>
  <a class="btn" href="${tgDeep}">Open Telegram</a>
  <p class="alt">Or open <a href="${tgWeb}">the web link</a></p>
  <script>
    // Try the native tg:// scheme first; if Telegram isn't installed, the
    // fallback below kicks in after 1.5s.
    setTimeout(function() { location.href = ${JSON.stringify(tgDeep)}; }, 100);
    setTimeout(function() { location.href = ${JSON.stringify(tgWeb)}; }, 1500);
  </script>
</body>
</html>`;
        return reply.code(200).type('text/html; charset=utf-8').send(html);
      }
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          suiAddress,
          traderProfileId: result.traderProfileId,
          coachGroupUuid: result.coachGroupUuid,
          auditGroupUuid: result.auditGroupUuid,
          created: result.created,
        },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  done();
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML rendering helpers for the deposit-action callback page.
// Mirrors the onboarding success page style so the UX feels consistent.
// All dynamic substitutions are JSON.stringify'd or string-typed; no raw user
// HTML is interpolated, so XSS surface here is the bot username and digest
// (both controlled by us / Sui).
// ─────────────────────────────────────────────────────────────────────────────

interface DepositHtmlOptions {
  outcome:
    | { ok: true; digest: string; amountMist: bigint }
    | { ok: false; message: string }
    | null;
  botUsername: string;
  tgDeep: string;
  tgWeb: string;
}

function renderDepositHtml(opts: DepositHtmlOptions): string {
  const { outcome, botUsername, tgDeep, tgWeb } = opts;
  const ok = outcome?.ok === true;
  const explorer = ok
    ? `https://suiscan.xyz/testnet/tx/${outcome.digest}`
    : '';
  const amountSui = ok
    ? (Number(outcome.amountMist) / 1e9).toFixed(4)
    : '';
  const errorMessage = !ok && outcome
    ? String(outcome.message ?? 'Unknown error').slice(0, 240)
    : '';

  const headerIcon = ok ? '✓' : '⚠';
  const headerColor = ok ? '#10b981' : '#ef4444';
  const title = ok ? 'Deposit Successful!' : 'Deposit Failed';

  const body = ok
    ? `
  <p>Deposited <strong style="color:#F2EEE6;">${escapeHtml(amountSui)} SUI</strong> into your BalanceManager.</p>
  <p class="alt">Transaction:</p>
  <div class="addr"><a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer" style="color:#FF6B35; text-decoration:none;">${escapeHtml(outcome!.digest.slice(0, 14))}…</a></div>
  <p>Returning you to @${escapeHtml(botUsername)}…</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Open Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`
    : `
  <p>We could not complete the on-chain deposit.</p>
  <div class="addr" style="color:#ef4444; max-width:100%; white-space:normal; word-break:break-word; text-align:left;">${escapeHtml(errorMessage)}</div>
  <p>Try /deposit again in the bot, or DM the operator if this persists.</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Back to Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse · Deposit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         background: #0B0B0B; color: #F2EEE6; max-width: 480px; margin: 60px auto; padding: 32px;
         text-align: center; line-height: 1.5; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.5px; }
  .check { color: ${headerColor}; font-size: 32px; margin-bottom: 16px; }
  .addr { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 13px;
          color: #7A7A7A; background: #131313; padding: 8px 12px; border-radius: 8px;
          display: inline-block; margin: 12px 0 24px; }
  p { color: #A0A0A0; margin: 12px 0; font-size: 14px; }
  .btn { display: inline-block; background: #FF6B35; color: #0B0B0B; padding: 14px 28px;
         border-radius: 999px; font-weight: 600; text-decoration: none; margin: 16px 8px;
         font-size: 15px; }
  .btn:hover { background: #FF8B5F; }
  .alt { font-size: 12px; color: #7A7A7A; }
  .alt a { color: #FF6B35; text-decoration: none; }
</style>
</head>
<body>
  <div class="check">${headerIcon}</div>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <script>
    // On success: bounce back to Telegram after a short delay so the user can
    // read the digest. On failure: do not auto-redirect — let the user read
    // the error.
    ${ok
      ? `setTimeout(function() { location.href = ${JSON.stringify(tgDeep)}; }, 2500);
    setTimeout(function() { location.href = ${JSON.stringify(tgWeb)}; }, 4000);`
      : ''}
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML rendering for the predict_setup + predict_mint callback pages.
// Mirrors the deposit success/failure layout so the UX feels consistent.
// ─────────────────────────────────────────────────────────────────────────────

interface PredictHtmlOptions {
  mode: 'setup' | 'mint' | 'redeem';
  outcome:
    | { ok: true; digest: string; predictManagerId?: string }
    | { ok: false; message: string }
    | null;
  botUsername: string;
  tgDeep: string;
  tgWeb: string;
}

function renderPredictHtml(opts: PredictHtmlOptions): string {
  const { mode, outcome, botUsername, tgDeep, tgWeb } = opts;
  const ok = outcome?.ok === true;
  const isAutoCredited = ok && outcome?.ok === true && outcome.digest === 'auto-credited';
  const explorer = ok && !isAutoCredited
    ? `https://suiscan.xyz/testnet/tx/${(outcome as { digest: string }).digest}`
    : '';
  const errorMessage = !ok && outcome
    ? String(outcome.message ?? 'Unknown error').slice(0, 240)
    : '';

  const headerIcon = ok ? '✓' : '⚠';
  const headerColor = ok ? '#10b981' : '#ef4444';
  const successTitle =
    mode === 'setup' ? 'Predict Account Ready!' :
    mode === 'redeem' && isAutoCredited ? 'Winnings Auto-Credited!' :
    mode === 'redeem' ? 'Winnings Claimed!' :
    'Prediction Placed!';
  const failTitle =
    mode === 'setup' ? 'Predict Setup Failed' :
    mode === 'redeem' ? 'Claim Failed' :
    'Prediction Failed';
  const title = ok ? successTitle : failTitle;

  const body = ok
    ? isAutoCredited
      ? `
  <p>Your winnings were automatically credited to your PredictManager by the protocol the moment the oracle settled.</p>
  <p>No action needed — use /balance to confirm your updated DUSDC balance.</p>
  <p>Returning you to @${escapeHtml(botUsername)}…</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Open Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`
    : `
  <p>${mode === 'setup'
      ? 'Your DeepBook Predict account is set up and funded with DUSDC.'
      : mode === 'redeem'
      ? 'Your winnings have been credited to your PredictManager.'
      : 'Your binary prediction has been placed on-chain.'}</p>
  <p class="alt">Transaction:</p>
  <div class="addr"><a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer" style="color:#FF6B35; text-decoration:none;">${escapeHtml((outcome as { digest: string }).digest.slice(0, 14))}…</a></div>
  <p>Returning you to @${escapeHtml(botUsername)}…</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Open Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`
    : `
  <p>${mode === 'setup'
      ? 'We could not set up your Predict account.'
      : mode === 'redeem'
      ? 'We could not claim your winnings.'
      : 'We could not place your prediction.'}</p>
  <div class="addr" style="color:#ef4444; max-width:100%; white-space:normal; word-break:break-word; text-align:left;">${escapeHtml(errorMessage)}</div>
  <p>${mode === 'redeem'
      ? 'Use /predict in the bot to place new predictions, or DM the operator if this persists.'
      : 'Try /predict again in the bot, or DM the operator if this persists.'}</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Back to Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse · Predict</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         background: #0B0B0B; color: #F2EEE6; max-width: 480px; margin: 60px auto; padding: 32px;
         text-align: center; line-height: 1.5; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.5px; }
  .check { color: ${headerColor}; font-size: 32px; margin-bottom: 16px; }
  .addr { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 13px;
          color: #7A7A7A; background: #131313; padding: 8px 12px; border-radius: 8px;
          display: inline-block; margin: 12px 0 24px; }
  p { color: #A0A0A0; margin: 12px 0; font-size: 14px; }
  .btn { display: inline-block; background: #FF6B35; color: #0B0B0B; padding: 14px 28px;
         border-radius: 999px; font-weight: 600; text-decoration: none; margin: 16px 8px;
         font-size: 15px; }
  .btn:hover { background: #FF8B5F; }
  .alt { font-size: 12px; color: #7A7A7A; }
  .alt a { color: #FF6B35; text-decoration: none; }
</style>
</head>
<body>
  <div class="check">${headerIcon}</div>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <script>
    ${ok
      ? `setTimeout(function() { location.href = ${JSON.stringify(tgDeep)}; }, 2500);
    setTimeout(function() { location.href = ${JSON.stringify(tgWeb)}; }, 4000);`
      : ''}
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML rendering for the memwal_setup callback page.
// ─────────────────────────────────────────────────────────────────────────────

interface MemwalHtmlOptions {
  outcome:
    | { ok: true; digest1: string; digest2: string; accountId: string }
    | { ok: false; message: string }
    | null;
  botUsername: string;
  tgDeep: string;
  tgWeb: string;
}

function renderMemwalHtml(opts: MemwalHtmlOptions): string {
  const { outcome, botUsername, tgDeep, tgWeb } = opts;
  const ok = outcome?.ok === true;
  const explorer2 = ok ? `https://suiscan.xyz/testnet/tx/${outcome.digest2}` : '';
  const errorMessage = !ok && outcome
    ? String(outcome.message ?? 'Unknown error').slice(0, 240)
    : '';

  const headerIcon = ok ? '✓' : '⚠';
  const headerColor = ok ? '#10b981' : '#ef4444';
  const title = ok ? 'Coach Memory Active!' : 'MemWal Setup Failed';

  const body = ok
    ? `
  <p>Your encrypted memory account is live on Walrus.</p>
  <p>Every coaching conversation, trade, and prediction outcome is now<br>remembered across sessions — only you can decrypt it.</p>
  <p class="alt">Transaction 2 (add delegate key):</p>
  <div class="addr"><a href="${escapeHtml(explorer2)}" target="_blank" rel="noopener noreferrer" style="color:#FF6B35; text-decoration:none;">${escapeHtml(outcome!.digest2.slice(0, 14))}…</a></div>
  <p>Returning you to @${escapeHtml(botUsername)}…</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Open Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`
    : `
  <p>We could not complete the MemWal account setup.</p>
  <div class="addr" style="color:#ef4444; max-width:100%; white-space:normal; word-break:break-word; text-align:left;">${escapeHtml(errorMessage)}</div>
  <p>Try /memwal again in the bot, or DM the operator if this persists.</p>
  <a class="btn" href="${escapeHtml(tgDeep)}">Back to Telegram</a>
  <p class="alt">Or open <a href="${escapeHtml(tgWeb)}">the web link</a></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lighthouse · Coach Memory</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         background: #0B0B0B; color: #F2EEE6; max-width: 480px; margin: 60px auto; padding: 32px;
         text-align: center; line-height: 1.5; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.5px; }
  .check { color: ${headerColor}; font-size: 32px; margin-bottom: 16px; }
  .addr { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 13px;
          color: #7A7A7A; background: #131313; padding: 8px 12px; border-radius: 8px;
          display: inline-block; margin: 12px 0 24px; }
  p { color: #A0A0A0; margin: 12px 0; font-size: 14px; }
  .btn { display: inline-block; background: #FF6B35; color: #0B0B0B; padding: 14px 28px;
         border-radius: 999px; font-weight: 600; text-decoration: none; margin: 16px 8px;
         font-size: 15px; }
  .btn:hover { background: #FF8B5F; }
  .alt { font-size: 12px; color: #7A7A7A; }
  .alt a { color: #FF6B35; text-decoration: none; }
</style>
</head>
<body>
  <div class="check">${headerIcon}</div>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <script>
    ${ok
      ? `setTimeout(function() { location.href = ${JSON.stringify(tgDeep)}; }, 2500);
    setTimeout(function() { location.href = ${JSON.stringify(tgWeb)}; }, 4000);`
      : ''}
  </script>
</body>
</html>`;
}

/**
 * Minimal HTML escaper for attribute + text contexts. Used because we
 * interpolate untrusted-ish strings (bot username, error messages, digests).
 */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
