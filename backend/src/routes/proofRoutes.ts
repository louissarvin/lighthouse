/**
 * Verifiable audit-trail export.
 *
 * GET /proof/recommendation/:id
 *   Returns: {
 *     recommendationId, decision, guardian, atomaRequestHash, atomaResponseHash?,
 *     atomaNodeSignature?, sealIdentityHex, walrusBlobId, auditAnchorTxDigest,
 *     executorAgentId, profileObjectId, suiAddress, model, endpoint, createdAt
 *   }
 *
 * GET /proof/trade/:id
 *   Same shape for a Trade row.
 *
 * The output is a SINGLE JSON document the user can paste into a tweet,
 * Discord post, or judge's inbox to prove the entire chain:
 *   - Atoma request hash → reproducible LLM call
 *   - SEAL identity → on-chain access policy
 *   - Walrus blob ID → encrypted evidence
 *   - audit_anchor tx digest → on-chain pointer
 *   - executor agent id → capability scoping proof
 *
 * Public read (no auth) so judges can verify without onboarding.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import {
  LIGHTHOUSE_PACKAGE_ID,
  SEAL_PACKAGE_ID,
  WALRUS_AGGREGATOR_URL,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { buildSealIdentity } from '../services/AuditLoop.ts';
import { NAMESPACES } from '../lib/memwal.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
} from '../utils/errorHandler.ts';

export const proofRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get(
    '/recommendation/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      if (!id) return handleError(reply, 400, 'missing id', 'MISSING_ID');
      try {
        const rec = await prismaQuery.recommendation.findUnique({
          where: { id },
          include: { trader_profile: true },
        });
        if (!rec || rec.deleted_at) return handleNotFoundError(reply, 'Recommendation');
        const profile = rec.trader_profile;
        const sealIdentityHex = profile.profile_object_id
          ? safeBuildIdentity(profile.profile_object_id, NAMESPACES.trades)
          : null;

        // Best-effort lookup of the on-chain audit anchor tx digest by
        // joining Recommendation.walrus_blob_id → WalrusBlob.tx_digest.
        // Encoding note: EventIndexer stores blob_id as the UTF-8 hex of
        // the base64url id (see services/EventIndexer.handleAnchorRecorded).
        // Recommendation.walrus_blob_id is the raw base64url. We convert
        // for the lookup so both sides match.
        let auditAnchorTxDigest: string | null = null;
        if (rec.walrus_blob_id) {
          const utf8Hex = Buffer.from(rec.walrus_blob_id, 'utf8').toString(
            'hex',
          );
          const blobRow = await prismaQuery.walrusBlob.findFirst({
            where: { blob_id: utf8Hex, deleted_at: null },
            select: { tx_digest: true },
          });
          auditAnchorTxDigest = blobRow?.tx_digest ?? null;
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            kind: 'recommendation',
            recommendationId: rec.id,
            createdAt: rec.created_at,
            atoma: {
              model: rec.model,
              endpoint: rec.endpoint,
              requestHash: rec.atoma_request_hash,
              responseHash: rec.atoma_response_hash,
              nodeSignature: rec.node_signature,
            },
            decision: rec.response_json,
            guardian: {
              pass: rec.guardian_pass,
              summary: rec.guardian_summary,
            },
            seal: {
              packageId: SEAL_PACKAGE_ID,
              identityHex: sealIdentityHex,
              slice: NAMESPACES.trades,
            },
            walrus: rec.walrus_blob_id
              ? {
                  blobId: rec.walrus_blob_id,
                  readUrl: `${WALRUS_AGGREGATOR_URL}/v1/blobs/${rec.walrus_blob_id}`,
                }
              : null,
            sui: auditAnchorTxDigest ? { txDigest: auditAnchorTxDigest } : null,
            lighthouse: {
              packageId: LIGHTHOUSE_PACKAGE_ID || null,
              profileObjectId: profile.profile_object_id || null,
              executorAgentId: profile.executor_agent_id || null,
              suiAddress: profile.sui_address,
            },
            verification: {
              instructions:
                'Fetch `walrus.readUrl` for ciphertext. Reconstruct the SEAL identity via `[profile_id_32_bytes][\":\"][\"trades\"]`. Re-hash Atoma request to compare. Resolve `audit_anchor` tx digest against your indexer.',
            },
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.get('/trade/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!id) return handleError(reply, 400, 'missing id', 'MISSING_ID');
    try {
      const trade = await prismaQuery.trade.findUnique({
        where: { id },
        include: { trader_profile: true, recommendation: true },
      });
      if (!trade || trade.deleted_at) return handleNotFoundError(reply, 'Trade');
      const profile = trade.trader_profile;
      const sealIdentityHex = profile.profile_object_id
        ? safeBuildIdentity(profile.profile_object_id, NAMESPACES.trades)
        : null;
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          kind: 'trade',
          tradeId: trade.id,
          createdAt: trade.created_at,
          settledAt: trade.settled_at,
          status: trade.status,
          side: trade.side,
          pool: trade.pool_id,
          orderId: trade.order_id,
          clientOrderId: trade.client_order_id.toString(),
          price: trade.price.toString(),
          quantity: trade.quantity.toString(),
          notional: trade.notional.toString(),
          filledQuantity: trade.filled_quantity.toString(),
          recommendation: trade.recommendation
            ? {
                id: trade.recommendation.id,
                atomaRequestHash: trade.recommendation.atoma_request_hash,
                model: trade.recommendation.model,
                endpoint: trade.recommendation.endpoint,
              }
            : null,
          seal: {
            packageId: SEAL_PACKAGE_ID,
            identityHex: sealIdentityHex,
            slice: NAMESPACES.trades,
          },
          walrus: trade.walrus_blob_id
            ? {
                blobId: trade.walrus_blob_id,
                readUrl: `${WALRUS_AGGREGATOR_URL}/v1/blobs/${trade.walrus_blob_id}`,
              }
            : null,
          sui: trade.tx_digest
            ? { txDigest: trade.tx_digest }
            : null,
          lighthouse: {
            packageId: LIGHTHOUSE_PACKAGE_ID || null,
            profileObjectId: profile.profile_object_id || null,
            executorAgentId: profile.executor_agent_id || null,
            suiAddress: profile.sui_address,
          },
        },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  done();
};

function safeBuildIdentity(profileObjectId: string, slice: string): string | null {
  try {
    return buildSealIdentity(profileObjectId, slice);
  } catch {
    return null;
  }
}
