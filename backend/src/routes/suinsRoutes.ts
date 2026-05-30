/**
 * SuiNS routes — name resolution + walrus_site_id metadata writes.
 *
 *   POST /suins/set-walrus-site-id  (auth)
 *     Body: { nftId, siteObjectId, isSubname? }
 *     Builds and sponsors a SuinsTransaction.setUserData PTB writing
 *     `walrus_site_id` onto the user's `.sui` registration NFT.
 *
 *   GET  /suins/resolve/:name  (public)
 *     Returns `{ address }` or `{ address: null }`. Used by the public
 *     tearsheet route to find the owner of `alice.sui`.
 *
 *   POST /suins/record-nft-id   (auth)
 *     Body: { suinsNftId, suinsName }
 *     One-shot bind: the frontend tells us the user's SuinsRegistration NFT
 *     id and chosen apex SLD so we can sponsor metadata writes later.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { LIGHTHOUSE_PACKAGE_ID } from '../config/main-config.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { buildSetWalrusSiteIdTx, resolveSuiNS } from '../lib/suins.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface SetWalrusSiteIdBody {
  nftId?: string;
  siteObjectId?: string;
  isSubname?: boolean;
}

interface RecordNftIdBody {
  suinsNftId?: string;
  suinsName?: string;
}

export const suinsRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Public name resolve — no auth.
  app.get('/resolve/:name', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as { name: string };
    if (!name) return handleError(reply, 400, 'missing name', 'MISSING_NAME');
    try {
      const address = await resolveSuiNS(name);
      return reply.code(200).send({ success: true, error: null, data: { name, address } });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  // Auth-gated: sponsor a setUserData PTB.
  app.post(
    '/set-walrus-site-id',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as SetWalrusSiteIdBody;
      const missing: string[] = [];
      if (!body?.nftId) missing.push('nftId');
      if (!body?.siteObjectId) missing.push('siteObjectId');
      if (missing.length) return handleValidationError(reply, missing);

      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no bound sui address', 'NO_SUI_ADDRESS');
      }
      if (!LIGHTHOUSE_PACKAGE_ID) {
        // SuiNS Move calls don't depend on our package, but we still gate to
        // avoid sponsoring before deployment.
        return handleError(reply, 503, 'lighthouse package not configured', 'PKG_NOT_SET');
      }

      try {
        const tx = buildSetWalrusSiteIdTx(body.nftId!, body.siteObjectId!, body.isSubname ?? false);
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

  // Auth-gated: record the user's SuinsRegistration NFT id so future
  // setUserData calls can be built without re-passing it every time.
  app.post(
    '/record-nft-id',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as RecordNftIdBody;
      if (!body?.suinsNftId || !body?.suinsName) {
        return handleValidationError(reply, ['suinsNftId', 'suinsName']);
      }
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile', 'NO_PROFILE');
      }
      try {
        const profile = await prismaQuery.traderProfile.findUnique({
          where: { id: user.trader_profile_id },
        });
        if (!profile) return handleNotFoundError(reply, 'TraderProfile');
        await prismaQuery.traderProfile.update({
          where: { id: profile.id },
          data: { suins_nft_id: body.suinsNftId, suins_name: body.suinsName },
        });
        return reply.code(200).send({ success: true, error: null, data: { id: profile.id } });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
