/**
 * Onboarding routes — UC1 (LIGHTHOUSE.md §3.2 + §10.4 mega-PTB).
 *
 * POST /onboarding/build-tx
 *   Body: { usdcCoinId?, deepCoinId?, usdcType?, deepType?, shareBalanceManager? }
 *   Returns sponsored 6-call PTB for the user to sign once.
 *
 * After the user signs + we execute via /sponsor/execute, the indexer (or a
 * follow-up route) reads `objectChanges` and persists `balance_manager_id` +
 * `profile_object_id` on the TraderProfile.
 *
 * POST /onboarding/finalise
 *   Body: { digest }
 *   Reads the executed transaction's objectChanges and writes the resulting
 *   BalanceManager + TraderProfile IDs to the database. Idempotent.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import {
  DEEPBOOK_DBUSDC_TYPE,
} from '../config/main-config.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { buildOnboardingTx } from '../lib/deepbook.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { envelopeDecrypt } from '../lib/envelope.ts';
import { NAMESPACES, rememberBulk } from '../lib/memwal.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { RISK_QUESTIONS } from '../lib/setupQuestions.ts';
import { suiGrpc } from '../lib/sui.ts';
import {
  handleError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface BuildTxBody {
  usdcCoinId?: string;
  deepCoinId?: string;
  /// Override default DBUSDC type (e.g. for a different stablecoin).
  usdcType?: string;
  /// Override default DEEP type.
  deepType?: string;
  // `shareBalanceManager` is intentionally NOT exposed: `BalanceManager` has
  // no `drop` ability, so the PTB MUST consume the new BM via
  // `public_share_object`. Setting false would abort with "Unused value
  // without drop". We force-share inside the route below.
}

interface FinaliseBody {
  digest?: string;
}

export const onboardingRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/build-tx',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as BuildTxBody;
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      try {
        const tx = buildOnboardingTx({
          usdcCoinId: body?.usdcCoinId,
          deepCoinId: body?.deepCoinId,
          usdcType: body?.usdcType ?? DEEPBOOK_DBUSDC_TYPE,
          deepType: body?.deepType,
          // ALWAYS true — see BuildTxBody comment above.
          shareBalanceManager: true,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            note:
              '6-call atomic PTB per LIGHTHOUSE.md §10.4: ' +
              'balance_manager::new → optional deposits → trader_profile::create → share both. ' +
              'After execution, call POST /onboarding/finalise with the digest to extract object IDs.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/finalise',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as FinaliseBody;
      if (!body?.digest) return handleValidationError(reply, ['digest']);
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      try {
        const txResp = await suiGrpc.getTransaction({
          digest: body.digest!,
          include: { effects: true, objectChanges: true },
        });
        const ids = extractOnboardingObjectIds(txResp);
        if (!ids.profileObjectId || !ids.balanceManagerId) {
          return handleError(
            reply,
            502,
            'expected objectChanges not found in tx',
            'OBJECT_CHANGES_MISSING',
          );
        }
        await prismaQuery.traderProfile.update({
          where: { id: user.trader_profile_id },
          data: {
            profile_object_id: ids.profileObjectId,
            balance_manager_id: ids.balanceManagerId,
          },
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            profileObjectId: ids.profileObjectId,
            balanceManagerId: ids.balanceManagerId,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // GET /onboarding/risk-questions
  //
  // Returns the canonical risk-profile question list shared with the
  // Telegram bot's /setup state machine (see src/lib/setupQuestions.ts).
  // Public read-only — no PII, no rate limit beyond the global cap.
  app.get('/risk-questions', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({
      success: true,
      error: null,
      data: { questions: RISK_QUESTIONS },
    });
  });

  // POST /onboarding/risk-profile/complete
  //
  // Persists the user's 5 risk-profile answers and marks the profile as
  // having completed the wizard. Mirrors the Telegram bot's `/setup` flow
  // (src/lib/telegramBot.ts::handleSetupAnswer) so the web wizard reaches
  // the same end-state.
  //
  // The completion timestamp is written UNCONDITIONALLY (even if the
  // MemWal write fails), because the user has done their part — MemWal
  // persistence can be retried later. This matches the bot's behavior of
  // showing "✅ saved" even when memwalOk is false.
  app.post(
    '/risk-profile/complete',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }

      const body = (request.body ?? {}) as { answers?: unknown };
      if (!Array.isArray(body.answers)) {
        return handleValidationError(reply, ['answers']);
      }

      // Validate each answer shape; build a lookup by question id.
      const answerById = new Map<string, string>();
      for (const raw of body.answers) {
        if (!raw || typeof raw !== 'object') {
          return handleError(reply, 400, 'each answer must be an object', 'BAD_ANSWER_SHAPE');
        }
        const a = raw as { id?: unknown; text?: unknown };
        if (typeof a.id !== 'string' || typeof a.text !== 'string') {
          return handleError(
            reply,
            400,
            'each answer needs string `id` and `text`',
            'BAD_ANSWER_SHAPE',
          );
        }
        const trimmed = a.text.trim();
        if (trimmed.length === 0) {
          return handleError(reply, 400, `answer for ${a.id} is empty`, 'EMPTY_ANSWER');
        }
        if (trimmed.length > 1000) {
          return handleError(
            reply,
            400,
            `answer for ${a.id} exceeds 1000 chars`,
            'ANSWER_TOO_LONG',
          );
        }
        answerById.set(a.id, trimmed);
      }

      // Ensure every required question is answered.
      const missing: string[] = [];
      for (const q of RISK_QUESTIONS) {
        if (!answerById.has(q.id)) missing.push(q.id);
      }
      if (missing.length > 0) {
        return handleError(
          reply,
          400,
          `missing answers for: ${missing.join(', ')}`,
          'MISSING_ANSWERS',
          null,
          { missing },
        );
      }

      try {
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { id: user.trader_profile_id },
        });
        if (!profile) {
          return handleError(reply, 404, 'profile not found', 'PROFILE_NOT_FOUND');
        }

        // Build bulk items in the canonical RISK_QUESTIONS order so the
        // summary anchor line is deterministic.
        const orderedAnswers = RISK_QUESTIONS.map((q) => ({
          q,
          text: answerById.get(q.id) as string,
        }));

        const bulkItems = orderedAnswers.map(({ q, text }) => {
          let namespace: string;
          if (q.kind === 'goal') {
            namespace = NAMESPACES.goals;
          } else if (q.kind === 'experience') {
            // Mirrors the bot's "Preferred markets" → preferences mapping.
            namespace = NAMESPACES.preferences;
          } else {
            namespace = NAMESPACES.riskProfile;
          }
          return { text: `${q.id}: ${text}`, namespace };
        });

        const summaryLine =
          `Full onboarding profile completed ${new Date().toISOString()}: ` +
          orderedAnswers
            .map(({ q, text }) => `${q.id}="${text.replace(/"/g, '\\"')}"`)
            .join(' ');

        bulkItems.push({ text: summaryLine, namespace: NAMESPACES.riskProfile });

        let memwalPersisted = false;
        if (profile.memwal_account_id && profile.memwal_delegate_key_encrypted) {
          try {
            const delegateKey = envelopeDecrypt(
              profile.id,
              profile.memwal_delegate_key_encrypted,
            );
            const account = {
              delegateKey,
              accountId: profile.memwal_account_id,
            };
            await rememberBulk(account, bulkItems);
            memwalPersisted = true;
          } catch (e) {
            // Per bot parity: do NOT fail the request on MemWal write
            // failure. The user has completed their part; the persistence
            // can be retried later.
            console.warn(
              '[onboarding] rememberBulk failed:',
              (e as Error).message,
            );
          }
        }

        // Write the completion timestamp unconditionally.
        const completedAt = new Date();
        await prismaQuery.traderProfile.update({
          where: { id: profile.id },
          data: { risk_profile_completed_at: completedAt },
        });

        // Build the typed summary for the client.
        const byKind = (kind: string): string | null => {
          const found = orderedAnswers.find((a) => a.q.kind === kind);
          return found?.text ?? null;
        };
        const q4 = orderedAnswers.find((a) => a.q.id === 'q4_markets');
        const q5 = orderedAnswers.find((a) => a.q.id === 'q5_leverage');
        const q3 = orderedAnswers.find((a) => a.q.id === 'q3_drawdown');

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            riskProfileCompletedAt: completedAt.toISOString(),
            memwalPersisted,
            summary: {
              goal: byKind('goal'),
              horizon: byKind('horizon'),
              drawdown: q3?.text ?? null,
              markets: q4?.text ?? null,
              leverage: q5?.text ?? null,
            },
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};

interface ObjectChangeShape {
  type?: string;
  objectType?: string;
  objectId?: string;
}

function extractOnboardingObjectIds(
  txResp: unknown,
): { profileObjectId: string | null; balanceManagerId: string | null } {
  const r = txResp as { objectChanges?: ObjectChangeShape[] } | null;
  if (!r?.objectChanges) return { profileObjectId: null, balanceManagerId: null };
  let profileObjectId: string | null = null;
  let balanceManagerId: string | null = null;
  for (const c of r.objectChanges) {
    if (c.type !== 'created') continue;
    if (c.objectType?.endsWith('::trader_profile::TraderProfile')) {
      profileObjectId = c.objectId ?? null;
    }
    if (c.objectType?.endsWith('::balance_manager::BalanceManager')) {
      balanceManagerId = c.objectId ?? null;
    }
  }
  return { profileObjectId, balanceManagerId };
}
