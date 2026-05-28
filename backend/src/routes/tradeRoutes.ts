/**
 * Trade routes — backend-signed (server-as-executor) DeepBook entry point for
 * the web SPA.
 *
 * The web client has zero `@mysten/*` deps and cannot sign client-side; we
 * mirror the Telegram bot model where the EXECUTOR_AGENT keypair (held
 * server-side, persisted as `agent_address` on every ExecutorAgent the user
 * minted) signs `executor::place_limit_under_budget` on behalf of the user.
 *
 * Canonical reference: `tradeConfirmCallback` in src/lib/telegramBot.ts
 * (1737-1893). Behaviour MUST stay in lockstep — abort-code mapping, audit
 * bundling, DB persist all copied verbatim.
 *
 *   POST /trade/place-as-agent  (auth)
 *     Body: { baseType, quoteType, price (str BigInt FLOAT_SCALING),
 *             quantity (str BigInt raw), isBid,
 *             poolKey?, poolId?, payWithDeep?, orderType?, selfMatching?,
 *             expireTimestamp? (str BigInt ms), recommendationId?,
 *             auditWalrusBlobIdHex? }
 *     Returns: { digest, txStatus, hint? }
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { buildPlaceLimitTx, ORDER_TYPE, SELF_MATCHING } from '../lib/deepbook.ts';
import { getExecutorKeypair } from '../lib/keypairs.ts';
import { getCachedExecutorAgent } from '../lib/onChainAgent.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { suiGrpc } from '../lib/sui.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

interface PlaceAsAgentBody {
  /// Optional logical pool key (informational; not used to resolve poolId).
  poolKey?: string;
  /// Optional explicit pool object id (overrides DEEPBOOK_SUI_DBUSDC_POOL).
  poolId?: string;
  /// Full Move type tag e.g. `0x2::sui::SUI`.
  baseType?: string;
  quoteType?: string;
  /// DeepBook FLOAT_SCALING'd u64 price as stringified BigInt.
  price?: string;
  /// Base raw units u64 as stringified BigInt.
  quantity?: string;
  isBid?: boolean;
  payWithDeep?: boolean;
  orderType?: number;
  selfMatching?: number;
  /// Unix ms u64 as stringified BigInt. Defaults to now + 24h.
  expireTimestamp?: string;
  recommendationId?: string;
  /// Hex-encoded 32-byte Walrus blob id. If supplied, audit_anchor::record +
  /// transfer_to_owner are bundled into the same PTB (LIGHTHOUSE.md §10.5).
  auditWalrusBlobIdHex?: string;
}

/// 24h forward, in ms — matches the web spec default. The Telegram bot uses
/// the DeepBook MAX_TIMESTAMP sentinel (1844674407370955161) instead, but for
/// the web we prefer a real expiry so stale orders don't linger forever.
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Classify a DeepBook / Lighthouse abort error string into a human-readable
 * hint. Copied VERBATIM from telegramBot.ts:1797-1830 to guarantee parity.
 */
function classifyTradeError(err: string): string {
  // DeepBook order_info abort codes (module = order_info::validate_inputs):
  //   0 = EOrderInvalidPrice, 1 = EOrderBelowMinimumSize, 2 = EOrderInvalidLotSize,
  //   3 = EInvalidExpireTimestamp, 4 = EInvalidOrderType
  // Lighthouse executor abort codes (module = executor::place_limit_under_budget):
  //   0 = EBudgetExceeded, 3 = ENotAgent, 5 = ERevoked, 2 = EExpired
  if (err.includes('order_info') && err.includes('abort_code: 1')) {
    return 'Order below pool minimum size (1 SUI). Use at least 1 SUI.';
  }
  if (err.includes('order_info') && err.includes('abort_code: 2')) {
    return 'Order quantity is not a valid lot-size multiple (0.1 SUI increments).';
  }
  if (err.includes('order_info') && err.includes('abort_code: 3')) {
    return 'Order expiry timestamp is in the past. This is a backend bug.';
  }
  if (err.includes('order_info') && err.includes('abort_code: 0')) {
    return 'Order price is invalid or not aligned to tick size.';
  }
  if (
    err.includes('ENotAgent') ||
    (err.includes('executor') && err.includes('abort_code: 3'))
  ) {
    return 'ExecutorAgent agent_address mismatch. Re-run setup-trading.';
  }
  if (
    err.includes('EBudgetExceeded') ||
    (err.includes('executor') && err.includes('abort_code: 0'))
  ) {
    return 'Budget exceeded on-chain — try a smaller size.';
  }
  if (
    err.includes('EPackageVersionDisabled') ||
    err.includes('abort_code: 11')
  ) {
    // Lighthouse-vs-DeepBook version skew on testnet. Operator action required.
    return (
      'DeepBook version mismatch (code 11). The Lighthouse package needs to be ' +
      'upgraded against DeepBook testnet-v17. Contact the operator.'
    );
  }
  if (err.includes('ERevoked') || err.includes('abort_code: 5')) {
    return 'ExecutorAgent has been revoked. Re-run setup to mint a new one.';
  }
  if (err.includes('EExpired') || err.includes('abort_code: 2')) {
    return 'ExecutorAgent has expired. Re-run setup.';
  }
  return 'See suiscan.xyz/testnet for the full on-chain abort trace.';
}

export const tradeRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/place-as-agent',
    {
      preHandler: [authMiddleware],
      // Per-IP cap: executor pays gas DIRECTLY on this path (no Enoki sponsor).
      // Tight limit to bound gas drain on a compromised account.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }

      const body = (request.body ?? {}) as PlaceAsAgentBody;
      const missing: string[] = [];
      if (!body.baseType) missing.push('baseType');
      if (!body.quoteType) missing.push('quoteType');
      if (!body.price) missing.push('price');
      if (!body.quantity) missing.push('quantity');
      if (typeof body.isBid !== 'boolean') missing.push('isBid');
      if (missing.length) return handleValidationError(reply, missing);

      // Parse numeric inputs early; fail fast on bad shape so we never spend
      // gas on a malformed request.
      let price: bigint;
      let quantity: bigint;
      let expireTimestamp: bigint;
      try {
        price = BigInt(body.price!);
        quantity = BigInt(body.quantity!);
        if (price <= 0n) throw new Error('price must be > 0');
        if (quantity <= 0n) throw new Error('quantity must be > 0');
        expireTimestamp = body.expireTimestamp
          ? BigInt(body.expireTimestamp)
          : BigInt(Date.now() + DEFAULT_EXPIRY_MS);
      } catch (e) {
        return handleError(
          reply,
          400,
          `bad numeric input: ${(e as Error).message}`,
          'BAD_INPUT',
        );
      }

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.executor_agent_id || !profile.balance_manager_id) {
        return handleError(
          reply,
          409,
          'profile missing executor_agent_id or balance_manager_id',
          'EXECUTOR_NOT_READY',
        );
      }

      // Verify the cached ExecutorAgent's agent_address matches the executor
      // we hold. If not, on-chain place_limit_under_budget will abort with
      // ENotAgent (abort_code 3) — better to reject up-front and save gas.
      const executor = getExecutorKeypair();
      const executorAddress = executor.toSuiAddress();
      try {
        const snap = await getCachedExecutorAgent(
          profile.id,
          profile.executor_agent_id,
        );
        if (snap.agent_address !== executorAddress) {
          return handleError(
            reply,
            409,
            `ExecutorAgent agent_address (${snap.agent_address}) does not match the backend executor (${executorAddress}). Re-run setup.`,
            'AGENT_ADDRESS_MISMATCH',
          );
        }
        if (snap.revoked) {
          return handleError(
            reply,
            409,
            'ExecutorAgent has been revoked. Re-run setup.',
            'AGENT_REVOKED',
          );
        }
        if (snap.expires_at_ms > 0n && snap.expires_at_ms < BigInt(Date.now())) {
          return handleError(
            reply,
            409,
            'ExecutorAgent has expired. Re-run setup.',
            'AGENT_EXPIRED',
          );
        }
      } catch (e) {
        return handleError(
          reply,
          502,
          `failed to load on-chain ExecutorAgent: ${(e as Error).message}`,
          'AGENT_LOAD_FAILED',
          e as Error,
        );
      }

      // Build → sign → submit, mirroring telegramBot.ts:1758-1789.
      try {
        const auditBytes = body.auditWalrusBlobIdHex
          ? Uint8Array.from(Buffer.from(body.auditWalrusBlobIdHex, 'hex'))
          : undefined;

        const clientOrderId = BigInt(Date.now());
        const tx = buildPlaceLimitTx({
          executorAgentId: profile.executor_agent_id,
          balanceManagerId: profile.balance_manager_id,
          poolId: body.poolId,
          baseType: body.baseType!,
          quoteType: body.quoteType!,
          clientOrderId,
          orderType: body.orderType ?? ORDER_TYPE.NO_RESTRICTION,
          selfMatching: body.selfMatching ?? SELF_MATCHING.ALLOWED,
          price,
          quantity,
          isBid: body.isBid!,
          payWithDeep: body.payWithDeep ?? false,
          expireTimestamp,
          auditWalrusBlobIdBytes: auditBytes,
        });

        tx.setSender(executorAddress);
        tx.setGasBudget(200_000_000);

        const built = await tx.build({ client: suiGrpc as never });
        const sig = await executor.signTransaction(built);
        const result = (await suiGrpc.executeTransaction({
          transaction: built,
          signatures: [sig.signature],
        })) as {
          Transaction?: {
            digest?: string;
            status?: { success?: boolean; error?: string | null };
          };
          digest?: string;
        };
        const inner = result.Transaction ?? {};
        const digest = inner.digest ?? result.digest;
        const succeeded = inner.status?.success !== false;

        if (!digest || !succeeded) {
          const err = inner.status?.error ?? 'unknown';
          const hint = classifyTradeError(err);
          return handleError(
            reply,
            502,
            `trade failed on-chain: ${err}`,
            'TRADE_ABORTED',
            new Error(err),
            { hint, digest },
          );
        }

        // Persist Trade row. Best-effort: do NOT block success response on a
        // DB hiccup — on-chain is authoritative.
        try {
          await prismaQuery.trade.create({
            data: {
              trader_profile_id: profile.id,
              recommendation_id: body.recommendationId ?? null,
              pool_id: body.poolId ?? '',
              client_order_id: clientOrderId,
              side: body.isBid ? 'bid' : 'ask',
              price,
              quantity,
              notional: (price * quantity) / 1_000_000_000n,
              status: 'placed',
              tx_digest: digest,
            },
          });
        } catch (dbErr) {
          console.warn(
            '[trade/place-as-agent] DB persist failed (non-fatal):',
            (dbErr as Error).message,
          );
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest,
            txStatus: 'success',
            clientOrderId: clientOrderId.toString(),
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
