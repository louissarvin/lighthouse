/**
 * Audit routes — auditor-side helpers for the AuditCap NFT flow.
 *
 * Background (LIGHTHOUSE.md §8.4 + lighthouse_contract/sources/allowlist.move):
 *   When a TraderProfile owner calls `trader_profile::grant_audit`, the
 *   chain mints an `allowlist::AuditCap` NFT to the auditor's address and
 *   records the (auditor → valid_until_ms) tuple inside the profile's
 *   embedded allowlist. The cap is bearer-NFT: whoever holds it can call
 *   `seal_approve_audit` to fetch the SEAL key for the encrypted blob.
 *
 * Two routes:
 *   GET /audit/caps?address=<auditor>
 *     Public read. Enumerates AuditCap NFTs owned by `<auditor>` so the
 *     auditor's UI can list every trader they've been granted access to.
 *
 *   GET /audit/decrypt?capId=<id>&blobId=<id>
 *     STUB. SEAL audit-decrypt requires building a `seal_approve_audit`
 *     PTB and a SessionKey signed by the auditor's wallet — that flow is
 *     wallet-side, not backend-side, and is intentionally left for the
 *     frontend to drive. We surface a clear `{ unavailable: true }` so
 *     the UI can render a "feature pending" panel.
 *
 * Security:
 *   - Public reads (the cap itself is the on-chain authorization)
 *   - Address validation on `?address=` so a stray param can't reach Sui RPC
 *   - Per-IP rate limit (60/min) — getOwnedObjects is RPC-expensive at scale
 *   - No PII / private data ever flows through these routes
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { LIGHTHOUSE_PACKAGE_ID } from '../config/main-config.ts';
import { suiRpc } from '../lib/sui.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

interface OwnedObjectResp {
  data?: Array<{
    data?: {
      objectId?: string;
      content?: {
        fields?: {
          auditor?: string;
          valid_until_ms?: string;
        };
      };
    };
  }>;
}

function isValidSuiAddress(s: string): boolean {
  return /^0x[a-f0-9]{64}$/i.test(s);
}

export const auditRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // ─── GET /audit/caps?address=<auditor> ─────────────────────────────────
  app.get(
    '/caps',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { address } = request.query as { address?: string };
      if (!address) return handleError(reply, 400, 'missing address', 'MISSING_ADDRESS');
      if (!isValidSuiAddress(address)) {
        return handleError(reply, 400, 'invalid address', 'BAD_ADDRESS');
      }
      if (!LIGHTHOUSE_PACKAGE_ID) {
        return handleError(reply, 503, 'LIGHTHOUSE_PACKAGE_ID not configured', 'PKG_NOT_SET');
      }

      const capType = `${LIGHTHOUSE_PACKAGE_ID}::allowlist::AuditCap`;
      try {
        // Same JSON-RPC pattern as DepositService.ts and predictRoutes.ts.
        // We need `showContent` so the cap fields (auditor, valid_until_ms)
        // come back in the response without a second `getObject` round-trip.
        const ownedRpc = suiRpc as unknown as {
          getOwnedObjects: (args: {
            owner: string;
            filter?: { StructType?: string };
            options?: { showContent?: boolean; showType?: boolean };
          }) => Promise<OwnedObjectResp>;
        };
        const resp = await ownedRpc.getOwnedObjects({
          owner: address,
          filter: { StructType: capType },
          options: { showContent: true, showType: true },
        });

        const nowMs = Date.now();
        const caps = (resp.data ?? [])
          .map((o) => {
            const obj = o.data;
            if (!obj?.objectId) return null;
            const fields = obj.content?.fields;
            const validUntilMs = fields?.valid_until_ms
              ? Number(fields.valid_until_ms)
              : null;
            return {
              capId: obj.objectId,
              auditor: fields?.auditor ?? address,
              validUntilMs,
              isValid: validUntilMs != null && validUntilMs > nowMs,
              // Source profile lookup deferred: AuditCap does NOT carry a
              // back-pointer to its parent profile on-chain. Recovering it
              // would require either:
              //   (a) a `GrantCreated` Move event + indexer table, OR
              //   (b) scanning the mint tx and matching the profile object
              //       in the PTB inputs.
              // Both are out of scope for this wave. The frontend can
              // cross-reference via `/profile/by-suins/:name` when the user
              // already knows whose tearsheet they're auditing.
              profileObjectId: null as string | null,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        return reply.code(200).send({
          success: true,
          error: null,
          data: { caps },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // ─── GET /audit/decrypt?capId=<id>&blobId=<id> ─────────────────────────
  // STUB. The real flow requires:
  //   1. A SessionKey signed by the AUDITOR's wallet (not the backend's)
  //   2. A `seal_approve_audit(id, profile, cap, clock)` PTB
  //   3. Walrus read + SEAL decrypt
  // None of those steps can be safely centralized on the backend without
  // exfiltrating the auditor's session-key signing authority. The web
  // /audit page should drive this flow client-side via the SEAL SDK and
  // call /audit/caps purely for discovery.
  app.get(
    '/decrypt',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { capId, blobId } = request.query as { capId?: string; blobId?: string };
      if (!capId) return handleError(reply, 400, 'missing capId', 'MISSING_CAP_ID');
      if (!blobId) return handleError(reply, 400, 'missing blobId', 'MISSING_BLOB_ID');
      // Light validation so an obviously malformed call still 4xxs before
      // the response below.
      if (!isValidSuiAddress(capId)) {
        return handleError(reply, 400, 'invalid capId (must be 0x-prefixed object ID)', 'BAD_CAP_ID');
      }
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          unavailable: true,
          reason:
            'SEAL audit-decrypt is wallet-driven (auditor must sign a SessionKey + seal_approve_audit PTB); not implemented backend-side. ' +
            'Drive this flow via the SEAL SDK in the web frontend.',
          capId,
          blobId,
        },
      });
    },
  );

  done();
};
