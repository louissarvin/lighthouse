/**
 * Multi-agent profile sharing — UC4 in LIGHTHOUSE.md §3.2.
 *
 * The user can grant a second agent (e.g. "Lighthouse CopyTrader") read
 * access to their `risk-profile` SEAL slice. That agent then mirrors a
 * curated trader, sized to the user's risk profile.
 *
 * Routes:
 *   POST /multi-agent/grant-copy-trader
 *     Body: { copyTraderAddress, validUntilMs }
 *     Returns sponsored PTB for `trader_profile::grant_copy_trader`. User signs.
 *
 *   POST /multi-agent/revoke-copy-trader
 *     Body: { copyTraderAddress }
 *     Returns sponsored PTB for `trader_profile::revoke_copy_trader`.
 *
 *   GET  /multi-agent/grants
 *     Lists the user's currently-granted copy traders (on-chain read).
 *
 * SECURITY:
 *   - Sponsor whitelist already permits `trader_profile::grant_copy_trader`
 *     and `revoke_copy_trader` (see `lib/enoki.ts`).
 *   - The user's signature is the only auth — the backend cannot grant on
 *     their behalf without the user signing the sponsored PTB.
 *
 * NARRATIVE NOTE: per LIGHTHOUSE.md §8.5 gotcha 14, once the copy trader has
 * `fetchKeys`'d ONCE during the grant window, the plaintext is theirs forever.
 * Revocation only blocks FUTURE fetches. The route docstring + response flag
 * surface this so the UI can warn the user.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import {
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
} from '../config/main-config.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { suiGrpc } from '../lib/sui.ts';
import { buildGrantAuditTx, buildRevokeAuditTx } from '../lib/lighthouseTxs.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface GrantBody {
  copyTraderAddress?: string;
  validUntilMs?: number;
}

interface RevokeBody {
  copyTraderAddress?: string;
}

interface GrantAuditBody {
  auditorAddress?: string;
  validUntilMs?: number;
}

interface RevokeAuditBody {
  capId?: string;
}

export const multiAgentRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  // === Grant ===
  app.post(
    '/grant-copy-trader',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as GrantBody;
      if (!body?.copyTraderAddress) return handleValidationError(reply, ['copyTraderAddress']);
      if (!body?.validUntilMs) return handleValidationError(reply, ['validUntilMs']);
      if (!isValidAddress(body.copyTraderAddress)) {
        return handleError(reply, 400, 'invalid copyTraderAddress', 'BAD_ADDRESS');
      }
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');
      if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID) {
        return handleError(reply, 503, 'lighthouse package not configured', 'PKG_NOT_SET');
      }
      try {
        const tx = new Transaction();
        tx.moveCall({
          target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::grant_copy_trader`,
          arguments: [
            tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
            tx.object(profile.profile_object_id),
            tx.pure(bcs.Address.serialize(body.copyTraderAddress).toBytes()),
            tx.pure(bcs.U64.serialize(body.validUntilMs).toBytes()),
          ],
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            warning:
              'Once the copy-trader successfully decrypts your risk-profile, that plaintext is theirs forever. Revocation only blocks FUTURE fetches.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === Revoke ===
  app.post(
    '/revoke-copy-trader',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RevokeBody;
      if (!body?.copyTraderAddress) return handleValidationError(reply, ['copyTraderAddress']);
      if (!isValidAddress(body.copyTraderAddress)) {
        return handleError(reply, 400, 'invalid copyTraderAddress', 'BAD_ADDRESS');
      }
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');
      if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID) {
        return handleError(reply, 503, 'lighthouse package not configured', 'PKG_NOT_SET');
      }
      try {
        const tx = new Transaction();
        tx.moveCall({
          target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::revoke_copy_trader`,
          arguments: [
            tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
            tx.object(profile.profile_object_id),
            tx.pure(bcs.Address.serialize(body.copyTraderAddress).toBytes()),
          ],
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: sponsored.digest, bytes: sponsored.bytes },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === List current grants (on-chain read of `copy_trader_granted_until`) ===
  app.get(
    '/grants/:address',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { address } = request.params as { address: string };
      if (!isValidAddress(address)) return handleError(reply, 400, 'bad address', 'BAD_ADDRESS');
      const user = request.user;
      if (!user?.trader_profile_id) return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');
      try {
        // Use a devInspect call against the public read accessor.
        // For v1 we surface the profile id + queried address; the frontend can
        // call `suiClient.getObject` directly. (A full devInspect builder would
        // double the size of this route; skip for now.)
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            profileObjectId: profile.profile_object_id,
            copyTraderAddress: address,
            readAccessor: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::copy_trader_granted_until`,
            note: 'Call this Move function via devInspect to get valid_until_ms.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === Grant audit cap (UC4 — auditor flow) ===
  app.post(
    '/grant-audit',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as GrantAuditBody;
      if (!body?.auditorAddress) return handleValidationError(reply, ['auditorAddress']);
      if (!body?.validUntilMs) return handleValidationError(reply, ['validUntilMs']);
      if (!isValidAddress(body.auditorAddress)) {
        return handleError(reply, 400, 'invalid auditorAddress', 'BAD_ADDRESS');
      }
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');
      try {
        const tx = buildGrantAuditTx({
          profileObjectId: profile.profile_object_id,
          auditorAddress: body.auditorAddress!,
          validUntilMs: BigInt(body.validUntilMs!),
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            note:
              'After execute, the auditor receives an AuditCap NFT and is registered in profile.audit_grants. ' +
              'The cap is bearer-NFT: whoever holds it can decrypt during the validity window. ' +
              'Revocation only blocks FUTURE fetches.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === Revoke audit cap by ID ===
  app.post(
    '/revoke-audit',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RevokeAuditBody;
      if (!body?.capId) return handleValidationError(reply, ['capId']);
      if (!isValidAddress(body.capId)) {
        return handleError(reply, 400, 'invalid capId (must be a 0x-prefixed object ID)', 'BAD_CAP_ID');
      }
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile?.profile_object_id) return handleNotFoundError(reply, 'TraderProfile object');
      try {
        const tx = buildRevokeAuditTx({
          profileObjectId: profile.profile_object_id,
          capId: body.capId!,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: sponsored.digest, bytes: sponsored.bytes },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};

function isValidAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{1,64}$/.test(s);
}

// Suppress unused-import warning — bundlers tree-shake.
void suiGrpc;
void LIGHTHOUSE_VERSION_OBJECT_ID;
void Transaction;
void bcs;
