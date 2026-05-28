/**
 * POST /sponsor/place-limit  (JWT-gated via authMiddleware)
 *   Body: { recommendationId?, baseType, quoteType, clientOrderId, orderType,
 *           selfMatching, price, quantity, isBid, payWithDeep, expireTimestamp,
 *           poolId?, auditWalrusBlobIdHex? }
 *   The Sui address is derived from `request.user.sui_address`, not the body.
 *   Returns: { digest, bytes, clientOrderId } — client signs `bytes`, then POSTs
 *   {digest, signature, clientOrderId} to /sponsor/execute.
 *
 * POST /sponsor/execute  (JWT-gated via authMiddleware)
 *   Body: { digest, signature, clientOrderId? }
 *   Returns: { digest } — executed via Enoki sponsored path.
 *   When `clientOrderId` is present the matching Trade row (scoped to
 *   `request.user.trader_profile_id` AND `client_order_id`) is stamped with
 *   the resulting tx digest. When absent (non-trade sponsored flows like
 *   predict/memwal/audit/suins) no Trade update runs.
 *
 * Both routes are now JWT-gated (cookie OR Authorization header). The previous
 * unauthenticated shape exposed Enoki sponsor gas budget to anonymous drain
 * AND let attackers create Trade rows under arbitrary `trader_profile_id`s.
 *
 * Sponsor branch with `allowedMoveCallTargets` + `allowedAddresses` whitelist
 * defense per LIGHTHOUSE.md §16.2 (CRITICAL — never sponsor without both).
 *
 * ─── CLIENT-SIGNING CONTRACT ────────────────────────────────────────────────
 * CLIENT SIGNS: Web builds a sponsored PTB via one of the /…/build endpoints
 * (returns {digest, bytes}), signs the bytes with the user's zkLogin
 * ephemeral key via @mysten/dapp-kit's useSignTransaction (which delegates
 * to @mysten/enoki's EnokiKeypair), and POSTs the resulting signature here.
 *
 * Telegram bot path: same shape, but the bot reconstructs the zkLogin
 * ephemeral key server-side after each OAuth roundtrip and signs there.
 * Both paths converge on this endpoint.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { buildPlaceLimitTx } from '../lib/deepbook.ts';
import { executeSponsored, sponsorForAddress } from '../lib/enoki.ts';
import { suiRpc } from '../lib/sui.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface PlaceLimitBody {
  recommendationId?: string;
  baseType?: string;
  quoteType?: string;
  clientOrderId?: string;
  orderType?: number;
  selfMatching?: number;
  price?: string;
  quantity?: string;
  isBid?: boolean;
  payWithDeep?: boolean;
  expireTimestamp?: string;
  poolId?: string;
  /// If provided, bundle audit_anchor::record + transfer_to_owner in same PTB
  /// (LIGHTHOUSE.md §10.5 atomic trade+audit composition).
  /// Pass the 32-byte u256 Walrus blob ID form as hex string.
  auditWalrusBlobIdHex?: string;
}

/// Dry-run accepts the same fields as place-limit but ALSO accepts an
/// explicit suiAddress because the dry-run endpoint must work for any
/// authenticated user inspecting their own profile. The auth handler still
/// pins suiAddress to request.user.sui_address — body.suiAddress is ignored.
interface DryRunBody extends PlaceLimitBody {
  suiAddress?: string;
}

interface ExecuteBody {
  digest?: string;
  signature?: string;
  /// Optional. When present, the trade-stamping update runs scoped to this
  /// (trader_profile_id, client_order_id) tuple. When absent, no Trade row is
  /// touched — this is the predict/memwal/audit/suins sponsored path.
  clientOrderId?: string;
}

export const sponsorRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post(
    '/place-limit',
    {
      preHandler: [authMiddleware],
      // Same per-IP budget as /execute: each call burns Enoki sponsor gas to
      // build + sponsor a PTB, and pre-creates a Trade row.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = request.body as PlaceLimitBody;
      const missing: string[] = [];
      for (const k of [
        'baseType',
        'quoteType',
        'clientOrderId',
        'orderType',
        'selfMatching',
        'price',
        'quantity',
        'isBid',
        'payWithDeep',
        'expireTimestamp',
      ] as const) {
        if (body?.[k] === undefined || body?.[k] === null || body?.[k] === '') missing.push(k);
      }
      if (missing.length) return handleValidationError(reply, missing);

      // Always derive from the JWT — never trust a body-supplied address. The
      // previous shape accepted `body.suiAddress` and let any caller drain the
      // Enoki sponsor budget for arbitrary addresses.
      const suiAddress = user.sui_address;

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { sui_address: suiAddress },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (profile.id !== user.trader_profile_id) {
        // Should never happen — JWT pins profile_id; defense in depth.
        return handleError(reply, 403, 'profile mismatch', 'PROFILE_MISMATCH');
      }
      if (!profile.executor_agent_id || !profile.balance_manager_id) {
        return handleError(
          reply,
          409,
          'profile missing executor agent or balance manager',
          'EXECUTOR_NOT_READY',
        );
      }

      try {
        const auditBytes = body.auditWalrusBlobIdHex
          ? Uint8Array.from(Buffer.from(body.auditWalrusBlobIdHex, 'hex'))
          : undefined;
        const tx = buildPlaceLimitTx({
          executorAgentId: profile.executor_agent_id,
          balanceManagerId: profile.balance_manager_id,
          poolId: body.poolId,
          baseType: body.baseType!,
          quoteType: body.quoteType!,
          clientOrderId: BigInt(body.clientOrderId!),
          orderType: body.orderType!,
          selfMatching: body.selfMatching!,
          price: BigInt(body.price!),
          quantity: BigInt(body.quantity!),
          isBid: body.isBid!,
          payWithDeep: body.payWithDeep!,
          expireTimestamp: BigInt(body.expireTimestamp!),
          auditWalrusBlobIdBytes: auditBytes,
        });

        const sponsored = await sponsorForAddress(tx, suiAddress);

        // Pre-create the Trade row in 'placed' status; finalised by EventIndexer.
        await prismaQuery.trade.create({
          data: {
            trader_profile_id: profile.id,
            recommendation_id: body.recommendationId ?? null,
            pool_id: body.poolId ?? '',
            client_order_id: BigInt(body.clientOrderId!),
            side: body.isBid ? 'bid' : 'ask',
            price: BigInt(body.price!),
            quantity: BigInt(body.quantity!),
            notional: (BigInt(body.price!) * BigInt(body.quantity!)) / 1_000_000_000n,
            status: 'placed',
          },
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            // Echo so the client passes it back to /sponsor/execute and we
            // can scope the Trade-row update to (trader_profile, clientOrderId).
            clientOrderId: body.clientOrderId,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/execute',
    {
      preHandler: [authMiddleware],
      // Enoki sponsored-gas protection: each /execute call burns gas from the
      // sponsor account. 10/min/IP caps the per-IP gas drain while still
      // allowing a real user to retry on transient RPC failures.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = request.body as ExecuteBody;
      if (!body?.digest || !body?.signature) {
        return handleValidationError(reply, ['digest', 'signature']);
      }

      // Parse clientOrderId BEFORE submitting so a malformed value fails fast
      // and we don't burn Enoki gas only to silently skip the Trade update.
      let parsedClientOrderId: bigint | null = null;
      if (body.clientOrderId !== undefined && body.clientOrderId !== null && body.clientOrderId !== '') {
        try {
          parsedClientOrderId = BigInt(body.clientOrderId);
        } catch {
          return handleError(
            reply,
            400,
            'clientOrderId must be a stringified BigInt',
            'BAD_CLIENT_ORDER_ID',
          );
        }
      }

      try {
        const res = await executeSponsored(body.digest, body.signature);

        // Trade-stamping only runs for trade flows (clientOrderId present).
        // Non-trade flows (predict/memwal/audit/suins) skip this branch
        // entirely so we never write a tx_digest onto a stranger's Trade row.
        //
        // Scoping by BOTH trader_profile_id AND client_order_id is what closes
        // H2: the previous unscoped updateMany stamped every pending Trade row
        // in the table with the same digest, leaking cross-user history. We use
        // updateMany (not update) because there is no composite unique on
        // (trader_profile_id, client_order_id) — and we don't want to add one
        // here in case legacy rows collide. In practice each (user, cOID) pair
        // is created exactly once by /place-limit above, so this matches one row.
        if (parsedClientOrderId !== null) {
          try {
            const stamped = await prismaQuery.trade.updateMany({
              where: {
                trader_profile_id: user.trader_profile_id,
                client_order_id: parsedClientOrderId,
                tx_digest: null,
                status: 'placed',
              },
              data: { tx_digest: res.digest },
            });
            if (stamped.count === 0) {
              // No matching row is non-fatal: the on-chain tx already succeeded.
              // The EventIndexer will reconcile via the on-chain OrderPlaced
              // event. We just log and move on so the user gets their digest back.
              console.warn(
                `[sponsor/execute] no Trade row to stamp for ` +
                  `(${user.trader_profile_id}, ${parsedClientOrderId}) — ` +
                  `EventIndexer will reconcile`,
              );
            }
          } catch (err) {
            console.warn(
              `[sponsor/execute] Trade stamp failed for ` +
                `(${user.trader_profile_id}, ${parsedClientOrderId}): ` +
                `${(err as Error).message}`,
            );
          }
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: res.digest },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // === Dry-run preview (LIGHTHOUSE.md §4.4 step 6 Guardian) ===
  // Build the same place_limit PTB and run `devInspectTransactionBlock` against
  // testnet RPC to surface what WOULD happen — gas estimate, abort code, event
  // emissions — BEFORE the user signs. Powers the trade preview UI in §4.4.
  //
  // Auth-gated: dry-run still hits an RPC node and reveals the user's
  // BalanceManager state, so we require a valid session.
  app.post(
    '/dry-run-place-limit',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = request.body as DryRunBody;
      const missing: string[] = [];
      for (const k of [
        'baseType',
        'quoteType',
        'clientOrderId',
        'orderType',
        'selfMatching',
        'price',
        'quantity',
        'isBid',
        'payWithDeep',
        'expireTimestamp',
      ] as const) {
        if (body?.[k] === undefined || body?.[k] === null || body?.[k] === '') missing.push(k);
      }
      if (missing.length) return handleValidationError(reply, missing);

      const suiAddress = user.sui_address;
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { sui_address: suiAddress },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.executor_agent_id || !profile.balance_manager_id) {
        return handleError(
          reply,
          409,
          'profile missing executor agent or balance manager',
          'EXECUTOR_NOT_READY',
        );
      }

      try {
        const auditBytes = body.auditWalrusBlobIdHex
          ? Uint8Array.from(Buffer.from(body.auditWalrusBlobIdHex, 'hex'))
          : undefined;
        const tx = buildPlaceLimitTx({
          executorAgentId: profile.executor_agent_id,
          balanceManagerId: profile.balance_manager_id,
          poolId: body.poolId,
          baseType: body.baseType!,
          quoteType: body.quoteType!,
          clientOrderId: BigInt(body.clientOrderId!),
          orderType: body.orderType!,
          selfMatching: body.selfMatching!,
          price: BigInt(body.price!),
          quantity: BigInt(body.quantity!),
          isBid: body.isBid!,
          payWithDeep: body.payWithDeep!,
          expireTimestamp: BigInt(body.expireTimestamp!),
          auditWalrusBlobIdBytes: auditBytes,
        });
        // Build transaction bytes ONLY (not signed).
        const txBytes = await tx.build({ client: suiRpc as never, onlyTransactionKind: true });
        const result = await suiRpc.devInspectTransactionBlock({
          sender: suiAddress,
          transactionBlock: Buffer.from(txBytes).toString('base64'),
        });
        const success = result?.effects?.status?.status === 'success';
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            willSucceed: success,
            status: result?.effects?.status,
            gasUsed: result?.effects?.gasUsed,
            eventsCount: result?.events?.length ?? 0,
            events: result?.events?.slice(0, 5),
            errorCode: success ? null : (result?.effects?.status as { error?: string })?.error,
            note:
              'devInspectTransactionBlock simulation only. Real execution may differ if pool state changes ' +
              'between dry-run and sign — refresh within ' + (5_000 / 1000).toFixed(0) + 's per Guardian freshness check.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
