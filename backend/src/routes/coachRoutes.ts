/**
 * POST /coach/recommend
 *   Body: { suiAddress, userPrompt, market: { mid_price, fetched_at_ms } }
 *   Returns: { decision, guardian, atomaRequestHash, atomaModel, recalledMemories, recommendationId }
 *
 * GET  /coach/chat?prompt=... (SSE; streams Atoma tokens)
 *   Uses `reply.hijack()` + `reply.raw.write('data: ...\n\n')` per Fastify v5 docs.
 *
 * Persists a Recommendation row on every successful call so the audit trail is
 * complete even before Walrus write succeeds.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { createHash } from 'node:crypto';

import { prismaQuery } from '../lib/prisma.ts';
import { recommend, type CoachRequest } from '../services/CoachOrchestrator.ts';
import { chatCreateStream, type ChatMessage } from '../lib/atoma.ts';
import { anchorText } from '../lib/coachAnchor.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { getCachedExecutorAgent } from '../lib/onChainAgent.ts';
import { getSuiDbusdcMidPrice, getSuiDbusdcOrderbook } from '../lib/deepbookQueries.ts';
import { envelopeDecrypt } from '../lib/envelope.ts';
import { archiveBlob, KIND_RECOMMENDATION } from '../services/AuditLoop.ts';
import { NAMESPACES, rememberRecommendation } from '../lib/memwal.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { blobIdToInt } from '@mysten/walrus';
import { LIGHTHOUSE_PACKAGE_ID, LIGHTHOUSE_VERSION_OBJECT_ID } from '../config/main-config.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

/// Max chat text length we'll anchor. Walrus charges per-byte, the Coach
/// drives the gas budget for the AuditAnchor PTB, and a runaway snippet
/// makes neither side happy.
const MAX_ANCHOR_TEXT_BYTES = 16_384;

interface AnchorReplyBody {
  /// Free-form chat text to pin. UTF-8. Required.
  text?: string;
  /// Optional user prompt that produced this reply — stored alongside for
  /// reproducibility but never anchored separately.
  originalUserPrompt?: string;
  /// Optional indicator of which model produced the reply, so the receipt
  /// page can render an honest attribution. Defaults to the Atoma chat model
  /// when the caller doesn't know.
  model?: string;
}

interface RecommendBody {
  suiAddress?: string;
  userPrompt?: string;
  market?: { mid_price?: string; fetched_at_ms?: number };
}

export const coachRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post(
    '/recommend',
    {
      // Atoma quota protection: each call hits a paid mainnet-alpha endpoint.
      // 20/min/IP is generous for a real user (~3s think time between trades)
      // while bounding the damage from refresh-bursts or a leaked endpoint.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as RecommendBody;
    const missing: string[] = [];
    if (!body?.suiAddress) missing.push('suiAddress');
    if (!body?.userPrompt) missing.push('userPrompt');
    if (!body?.market?.mid_price) missing.push('market.mid_price');
    if (!body?.market?.fetched_at_ms) missing.push('market.fetched_at_ms');
    if (missing.length) return handleValidationError(reply, missing);

    const profile = await prismaQuery.traderProfile.findUnique({
      where: { sui_address: body.suiAddress! },
    });
    if (!profile) return handleNotFoundError(reply, 'TraderProfile');
    if (!profile.memwal_account_id) {
      return handleError(reply, 409, 'memwal account not bootstrapped', 'MEMWAL_NOT_READY');
    }
    if (!profile.executor_agent_id) {
      return handleError(reply, 409, 'no executor agent for this profile', 'NO_EXECUTOR_AGENT');
    }
    if (!profile.memwal_delegate_key_encrypted) {
      return handleError(reply, 409, 'memwal delegate key not provisioned', 'MEMWAL_DELEGATE_MISSING');
    }

    // Live on-chain ExecutorAgent snapshot (TTL-cached).
    let agent;
    try {
      const snap = await getCachedExecutorAgent(profile.id, profile.executor_agent_id);
      agent = {
        allowed_pools: snap.allowed_pools,
        max_notional_per_trade: snap.max_notional_per_trade,
        max_notional_per_day: snap.max_notional_per_day,
        spent_today: snap.spent_today,
      };
    } catch (e) {
      return handleError(reply, 502, 'failed to fetch executor agent state', 'AGENT_FETCH_FAILED', e as Error);
    }

    // Decrypt the per-user MemWal delegate key.
    let delegateKey: string;
    try {
      delegateKey = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
    } catch (e) {
      return handleError(reply, 500, 'failed to decrypt MemWal delegate key', 'DELEGATE_DECRYPT_FAILED', e as Error);
    }

    // Best-effort live orderbook fetch — Guardian uses real depth when present
    // (DeepBook narrative win). Falls back to linear-from-mid if the fetch fails.
    let book: { bids: { price: bigint; quantity: bigint }[]; asks: { price: bigint; quantity: bigint }[] } | null = null;
    try {
      book = await getSuiDbusdcOrderbook(10);
    } catch (e) {
      console.warn('[coach] orderbook fetch failed (using mid-only):', (e as Error).message);
    }

    try {
      const req: CoachRequest = {
        userPrompt: body.userPrompt!,
        memwal: { delegateKey, accountId: profile.memwal_account_id },
        agent,
        market: {
          mid_price: BigInt(body.market!.mid_price!),
          fetched_at_ms: body.market!.fetched_at_ms!,
          ...(book ? { bids: book.bids, asks: book.asks } : {}),
        },
      };
      const res = await recommend(req);

      // Persist the recommendation row up front (Walrus + MemWal writes happen
      // BEST-EFFORT after; the on-chain audit blob ID is patched in once the
      // archive succeeds).
      const row = await prismaQuery.recommendation.create({
        data: {
          trader_profile_id: profile.id,
          atoma_request_hash: res.atomaRequestHash,
          atoma_response_hash: res.atomaResponseHash,
          node_signature: res.atomaNodeSignature,
          response_json: res.decision as unknown as never,
          model: res.atomaModel,
          endpoint: res.atomaEndpoint,
          guardian_summary: res.guardian.summary,
          guardian_pass: res.guardian.overall_pass,
        },
      });

      // === Archive loop: SEAL → Walrus → audit_anchor + MemWal remember ===
      // Best-effort. Failure here does NOT block the response — the
      // recommendation row already exists for replay/repair.
      let walrusBlobId: string | null = null;
      let memwalBlobId: string | null = null;
      let auditAnchorTxDigest: string | null = null;
      try {
        const rememberText = buildRememberText(res);
        if (profile.profile_object_id) {
          const archive = await archiveBlob({
            profileObjectId: profile.profile_object_id,
            slice: NAMESPACES.trades,
            plaintext: JSON.stringify({
              decision: res.decision,
              recalled: res.recalledMemories,
              guardian: res.guardian,
              atomaRequestHash: res.atomaRequestHash,
              atomaModel: res.atomaModel,
            }),
            kind: KIND_RECOMMENDATION,
            memwal: { delegateKey, accountId: profile.memwal_account_id, rememberText },
          });
          walrusBlobId = archive.walrusBlobId;
          memwalBlobId = archive.memwalBlobId;
          auditAnchorTxDigest = archive.auditAnchorTxDigest;
        } else {
          // No profile object id yet — only MemWal remember.
          const r = await rememberRecommendation(
            { delegateKey, accountId: profile.memwal_account_id },
            rememberText,
          );
          memwalBlobId = r.blobId;
        }
        await prismaQuery.recommendation.update({
          where: { id: row.id },
          data: { walrus_blob_id: walrusBlobId ?? memwalBlobId },
        });
      } catch (archiveErr) {
        console.warn('[coach] archive loop failed (recommendation persisted):', (archiveErr as Error).message);
      }

      // === Optional: prepare a USER-SIGNED audit anchor PTB for the recommendation ===
      // The Walrus blob already exists (coach wrote it). The user can sign a
      // sponsored audit_anchor::record(kind=0) PTB to claim non-repudiation:
      // "I (the user) acknowledge receiving this recommendation at this moment,
      //  pinned to this Walrus blob ID."
      // This is OPTIONAL — frontend may skip if user doesn't care about signing.
      let userAuditPtb: { digest: string; bytes: string } | null = null;
      if (
        walrusBlobId &&
        profile.profile_object_id &&
        LIGHTHOUSE_PACKAGE_ID &&
        LIGHTHOUSE_VERSION_OBJECT_ID
      ) {
        try {
          const u256 = blobIdToInt(walrusBlobId);
          const rawBlobBytes = bcs.u256().serialize(u256).toBytes();
          const tx = new Transaction();
          const [anchor] = tx.moveCall({
            target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
            arguments: [
              tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
              tx.pure(bcs.U8.serialize(0).toBytes()), // kind=0 recommendation
              tx.pure(bcs.vector(bcs.U8).serialize(Array.from(rawBlobBytes)).toBytes()),
              tx.pure(bcs.vector(bcs.U8).serialize(Array.from(new Uint8Array(32))).toBytes()),
              tx.object('0x6'),
            ],
          });
          tx.moveCall({
            target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
            arguments: [anchor],
          });
          userAuditPtb = await sponsorForAddress(tx, body.suiAddress!);
        } catch (e) {
          console.warn('[coach] failed to build user audit PTB:', (e as Error).message);
        }
      }

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          recommendationId: row.id,
          decision: res.decision,
          guardian: res.guardian,
          recalledMemories: res.recalledMemories,
          atomaRequestHash: res.atomaRequestHash,
          atomaModel: res.atomaModel,
          walrusBlobId,
          memwalBlobId,
          auditAnchorTxDigest, // coach-signed (always present)
          // User-signed PTB for non-repudiation (optional, frontend signs).
          userAuditPtb,
        },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  },
  );

  // ─── POST /coach/anchor-reply ──────────────────────────────────────────
  // Take a free-form chat reply, upload it to Walrus (Coach keypair), and
  // emit `audit_anchor::record(kind=0)` in the same flow. Result is the
  // single most demo-able Walrus moment: "what the AI told me, on chain in
  // 2 seconds, no user signature required."
  //
  // We persist a `Recommendation` row with a synthetic shape so /receipt/<id>
  // resolves it. The honest framing is captured in `response_json.kind ===
  // 'chat-anchor'` — the receipt page and proof endpoint treat it as a
  // verifiable chat snippet, not a guarded trade recommendation. Guardian
  // fields stay null (no decision was evaluated).
  app.post(
    '/anchor-reply',
    {
      preHandler: [authMiddleware],
      // anchorText() does a Walrus PUT (paid sponsor + gas-paying coach key)
      // plus an on-chain PTB. Tighter cap than /recommend because each call
      // burns Coach gas and Walrus space.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as AnchorReplyBody;
      if (!body?.text || typeof body.text !== 'string') {
        return handleValidationError(reply, ['text']);
      }
      const text = body.text.trim();
      if (text.length === 0) return handleValidationError(reply, ['text']);
      if (Buffer.byteLength(text, 'utf8') > MAX_ANCHOR_TEXT_BYTES) {
        return handleError(
          reply,
          413,
          `text exceeds ${MAX_ANCHOR_TEXT_BYTES} bytes`,
          'ANCHOR_TEXT_TOO_LARGE',
        );
      }

      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no bound trader profile', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      try {
        // 1. Walrus upload + audit_anchor::record in one Coach-signed flow.
        //    (anchorText already handles size validation + retries.)
        const anchor = await anchorText(text);

        // 2. Persist a Recommendation row. Synthetic-but-honest shape — the
        //    /proof/recommendation/:id endpoint treats `kind: chat-anchor` as
        //    a free-form snippet, not a guarded decision.
        const requestHash = createHash('sha256').update(text).digest('hex');
        const row = await prismaQuery.recommendation.create({
          data: {
            trader_profile_id: profile.id,
            atoma_request_hash: requestHash,
            atoma_response_hash: null,
            node_signature: null,
            response_json: {
              kind: 'chat-anchor',
              text,
              originalUserPrompt: body.originalUserPrompt ?? null,
              source: 'web-coach-chat',
            } as never,
            model: body.model ?? 'atoma-chat',
            endpoint: 'standard',
            walrus_blob_id: anchor.blobId,
            guardian_summary: 'Free-form chat anchor (no decision evaluated)',
            guardian_pass: true,
          },
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            recommendationId: row.id,
            walrusBlobId: anchor.blobId,
            walrusReadUrl: anchor.blobUrl,
            auditAnchorTxDigest: anchor.digest,
            explorerUrl: anchor.explorerUrl,
            receiptUrl: `/receipt/${row.id}`,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // SSE token stream
  app.get('/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const prompt = (request.query as { prompt?: string })?.prompt;
    if (!prompt) {
      return handleValidationError(reply, ['prompt']);
    }
    // reply.hijack() takes raw socket control AWAY from Fastify, which means
    // the @fastify/cors plugin never sets the Access-Control-* headers on this
    // response. Browser fetch() with `credentials: 'include'` then rejects the
    // response with "Failed to fetch" even though the server returned 200.
    // Manually echo the request origin (specific, not '*' — required when
    // credentials are included). Wildcard would be rejected by the browser.
    const origin = request.headers.origin;
    const corsHeaders: Record<string, string> = {};
    if (origin) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
      corsHeaders['Access-Control-Allow-Credentials'] = 'true';
      corsHeaders['Vary'] = 'Origin';
    }
    reply.raw.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable nginx-style buffering if the SSE goes through a reverse proxy.
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are Lighthouse, a verifiable AI trading coach. Reply conversationally; the user is not asking for JSON here.',
      },
      { role: 'user', content: prompt },
    ];
    try {
      for await (const chunk of chatCreateStream(messages)) {
        reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      reply.raw.write(`event: done\ndata: {}\n\n`);
    } catch (e) {
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  });

  done();
};

/**
 * Distil the coach response into a single-line memory text suitable for
 * MemWal's vector index. Short, factual, no model boilerplate.
 */
function buildRememberText(res: {
  decision: { side: string; pool: string; price: string; quantity: string; reasoning?: string };
  guardian: { overall_pass: boolean };
}): string {
  const verdict = res.guardian.overall_pass ? 'PASSED' : 'BLOCKED';
  const side = res.decision.side.toUpperCase();
  return (
    `[${verdict}] ${side} ${res.decision.quantity} @ ${res.decision.price} ` +
    `pool=${res.decision.pool.slice(0, 10)}…` +
    (res.decision.reasoning ? ` — ${res.decision.reasoning.slice(0, 200)}` : '')
  );
}

/**
 * Auto-fetch the mid price if the client did not provide one. Convenience for
 * the SUI_DBUSDC pool — extend when multi-pool routing arrives.
 */
export async function autofillMidPrice(): Promise<bigint> {
  try {
    return await getSuiDbusdcMidPrice();
  } catch (e) {
    console.warn('[coachRoutes] mid-price fetch failed:', (e as Error).message);
    return 0n;
  }
}
