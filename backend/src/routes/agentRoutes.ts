/**
 * Executor agent management routes.
 *
 *   POST /agent/revoke  (auth)
 *     Builds + sponsors a `lighthouse::executor::revoke` PTB. User signs in
 *     the web app (or Mini App), then calls /sponsor/execute with the digest
 *     + signature to finalise.
 *
 * UC5 (LIGHTHOUSE.md §3.2): "Capability revocation". Sets `revoked = true`
 * on the agent AND deregisters the TradeCap from the BalanceManager.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import { buildRevokeAgentWithProofTx } from '../lib/lighthouseTxs.ts';
import { getCachedExecutorAgent } from '../lib/onChainAgent.ts';
import { getAllManagerBalances } from '../lib/deepbookQueries.ts';
import { getPredictManagerDusdcBalance, getWalletBalances } from '../lib/predict.ts';
import { SUI_RPC_URL, DUSDC_TYPE_TAG } from '../config/main-config.ts';
import { createHash } from 'node:crypto';
import { getExecutorKeypair } from '../lib/keypairs.ts';
import { buildDepositTx } from '../lib/deepbook.ts';
import { suiGrpc } from '../lib/sui.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

const SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// In-memory per-user cache for /agent/balances. 10s TTL — absorbs the
// frontend's 60s refetch + manual refresh button without making every
// component mount re-hit RPC for three balance sources. The web's
// BalancesCard staleTime is 30s but the in-flight `Refresh` button bypasses
// React Query cache entirely, so the server cache is what protects RPC.
const BALANCES_CACHE_TTL_MS = 10_000;
const balancesCache = new Map<string, { at: number; payload: unknown }>();

export const agentRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // GET /agent/snapshot
  //
  // Returns the cached ExecutorAgent snapshot for the authenticated user.
  // Drives the portfolio's `ProfileCard` budget summary + the /trade form's
  // in-budget validator. Cached per `EXECUTOR_AGENT_CACHE_TTL_MS` (default 60s).
  app.get(
    '/snapshot',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');
      if (!profile.executor_agent_id) {
        // Not an error — user simply hasn't run setup-trading yet.
        return reply.code(200).send({
          success: true,
          error: null,
          data: { ready: false, snapshot: null },
        });
      }
      try {
        const snap = await getCachedExecutorAgent(profile.id, profile.executor_agent_id);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            ready: true,
            executor_agent_id: profile.executor_agent_id,
            balance_manager_id: profile.balance_manager_id,
            snapshot: {
              agent_address: snap.agent_address,
              owner_address: snap.owner_address,
              balance_manager_id: snap.balance_manager_id,
              allowed_pools: snap.allowed_pools,
              max_notional_per_trade: snap.max_notional_per_trade.toString(),
              max_notional_per_day: snap.max_notional_per_day.toString(),
              spent_today: snap.spent_today.toString(),
              window_start_ms: snap.window_start_ms.toString(),
              expires_at_ms: snap.expires_at_ms.toString(),
              revoked: snap.revoked,
            },
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  app.post(
    '/revoke',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address || !user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
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
      try {
        // ATOMIC: executor::revoke + audit_anchor::record + transfer_to_owner
        // in ONE PTB. The revocation event cannot be separated from its
        // audit trail. If the user provided a Walrus blob id explaining the
        // reason, anchor it. Otherwise anchor a 32-byte SHA-256 of the agent
        // id so the on-chain anchor still carries verifiable provenance.
        const body = (request.body ?? {}) as { reasonBlobIdHex?: string };
        const reasonBytes = body.reasonBlobIdHex
          ? Uint8Array.from(Buffer.from(body.reasonBlobIdHex, 'hex'))
          : new Uint8Array(
              createHash('sha256').update(profile.executor_agent_id).digest(),
            );

        const tx = buildRevokeAgentWithProofTx({
          executorAgentId: profile.executor_agent_id,
          balanceManagerId: profile.balance_manager_id,
          revocationBlobIdBytes: reasonBytes,
        });
        const sponsored = await sponsorForAddress(tx, user.sui_address);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            digest: sponsored.digest,
            bytes: sponsored.bytes,
            note: 'After execute: on-chain `revoked=true`, TradeCap deregistered from BalanceManager, and an AuditAnchor recording the revocation event is transferred to you.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // GET /agent/balances
  //
  // Aggregated balance view across the three sources the Telegram /balance
  // command exposes: DeepBook BalanceManager (SUI + DBUSDC), PredictManager
  // (DUSDC + open position count), and the user's own wallet (SUI + DUSDC).
  //
  // Each source is best-effort. A failure on one does not break the others —
  // missing/erroring sections come back with `available: false` and null
  // values so the UI can render a partial view safely.
  app.get(
    '/balances',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      // Cache hit? Return immediately. Per-user keyed.
      const cached = balancesCache.get(user.trader_profile_id);
      if (cached && Date.now() - cached.at < BALANCES_CACHE_TTL_MS) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: cached.payload,
        });
      }

      const fromSuiRaw = (raw: bigint | number): string =>
        (Number(raw) / 1e9).toFixed(6);
      const from6DecimalRaw = (raw: bigint | number): string =>
        (Number(raw) / 1e6).toFixed(6);

      // Run the three fetches in parallel. We wrap each one in its own
      // try/catch via Promise.allSettled so a single 5xx from a JSON-RPC
      // hop never poisons the whole response.
      const balanceManagerPromise: Promise<
        { available: true; sui: string; dbusdc: string } | { available: false }
      > = (async () => {
        if (!profile.balance_manager_id) return { available: false } as const;
        try {
          const rows = await getAllManagerBalances(profile.balance_manager_id);
          // `getAllManagerBalances` (DeepBook SDK `checkManagerBalance`) returns
          // HUMAN DECIMALS as strings (e.g. "2.1" SUI, "100.5" DBUSDC), NOT raw
          // base units. Previously we wrapped these in BigInt which threw
          // (`BigInt("2.1")` is a SyntaxError), so the whole BM section
          // silently dropped to `available: false`. Format directly instead.
          const suiHuman = rows.find((r) => r.coin === 'SUI')?.balance ?? '0';
          const dbusdcHuman = rows.find((r) => r.coin === 'DBUSDC')?.balance ?? '0';
          const fmt = (s: string): string => {
            const n = Number(s);
            return Number.isFinite(n) ? n.toFixed(6) : '0.000000';
          };
          return {
            available: true as const,
            sui: fmt(suiHuman),
            dbusdc: fmt(dbusdcHuman),
          };
        } catch (e) {
          console.warn(
            '[agent/balances] balanceManager fetch failed:',
            (e as Error).message,
          );
          return { available: false } as const;
        }
      })();

      const predictManagerPromise: Promise<
        | { available: true; dusdc: string; positionCount: number }
        | { available: false }
      > = (async () => {
        if (!profile.predict_manager_id) return { available: false } as const;
        try {
          const { dusdcRaw, positionCount } = await getPredictManagerDusdcBalance(
            SUI_RPC_URL,
            profile.predict_manager_id,
          );
          return {
            available: true as const,
            dusdc: from6DecimalRaw(dusdcRaw),
            positionCount,
          };
        } catch (e) {
          console.warn(
            '[agent/balances] predictManager fetch failed:',
            (e as Error).message,
          );
          return { available: false } as const;
        }
      })();

      const walletPromise: Promise<{ sui: string; dusdc: string } | null> = (async () => {
        if (!profile.sui_address) return null;
        try {
          const { suiRaw, dusdcRaw } = await getWalletBalances(
            SUI_RPC_URL,
            profile.sui_address,
            DUSDC_TYPE_TAG,
          );
          return {
            sui: fromSuiRaw(suiRaw),
            dusdc: from6DecimalRaw(dusdcRaw),
          };
        } catch (e) {
          console.warn(
            '[agent/balances] wallet fetch failed:',
            (e as Error).message,
          );
          return null;
        }
      })();

      try {
        const [bm, pm, wallet] = await Promise.all([
          balanceManagerPromise,
          predictManagerPromise,
          walletPromise,
        ]);

        const balanceManager = bm.available
          ? {
              available: true,
              objectId: profile.balance_manager_id,
              sui: bm.sui,
              dbusdc: bm.dbusdc,
            }
          : {
              available: false,
              objectId: profile.balance_manager_id,
              sui: null,
              dbusdc: null,
            };

        const predictManager = pm.available
          ? {
              available: true,
              objectId: profile.predict_manager_id,
              dusdc: pm.dusdc,
              positionCount: pm.positionCount,
            }
          : {
              available: false,
              objectId: profile.predict_manager_id,
              dusdc: null,
              positionCount: 0,
            };

        const walletPayload = {
          suiAddress: profile.sui_address,
          sui: wallet?.sui ?? null,
          dusdc: wallet?.dusdc ?? null,
        };

        const payload = {
          balanceManager,
          predictManager,
          wallet: walletPayload,
          executorAddress: getExecutorKeypair().toSuiAddress(),
        };
        balancesCache.set(user.trader_profile_id, {
          at: Date.now(),
          payload,
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: payload,
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // GET /agent/executor-address
  //
  // Returns the executor keypair's Sui address so users know where to send
  // SUI for instant deposits. No auth required — the executor address is
  // public (it appears as `agent_address` on every shared ExecutorAgent).
  app.get('/executor-address', async (_request, reply) => {
    try {
      const addr = getExecutorKeypair().toSuiAddress();
      return reply.code(200).send({
        success: true,
        error: null,
        data: { executorAddress: addr },
      });
    } catch (e) {
      return handleServerError(reply, e as Error);
    }
  });

  // POST /agent/deposit-instant
  //
  // Backend-signed top-up of the user's BalanceManager using the executor's
  // DepositCap. The user funds the executor with SUI out-of-band (see
  // /agent/executor-address) and then calls this to mirror that SUI into
  // their BM. The executor splits the deposit amount from its own gas coin
  // (`tx.splitCoins(tx.gas, [amount])`), so the executor must hold enough
  // SUI balance — that is the caller's responsibility upstream.
  app.post(
    '/deposit-instant',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }

      const profile = await prismaQuery.traderProfile.findUnique({
        where: { id: user.trader_profile_id },
      });
      if (!profile) return handleNotFoundError(reply, 'TraderProfile');

      if (!profile.deposit_cap_id) {
        return handleError(
          reply,
          409,
          'deposit_cap not granted — complete OAuth deposit flow first',
          'DEPOSIT_CAP_MISSING',
        );
      }
      if (!profile.balance_manager_id) {
        return handleError(
          reply,
          409,
          'balance_manager not provisioned',
          'BM_MISSING',
        );
      }

      const body = (request.body ?? {}) as { amountMist?: string };
      let amount: bigint;
      try {
        if (typeof body.amountMist !== 'string' || body.amountMist.trim() === '') {
          throw new Error('amountMist must be a non-empty string');
        }
        amount = BigInt(body.amountMist);
      } catch {
        return handleError(
          reply,
          400,
          'amountMist must be a stringified BigInt > 0',
          'BAD_AMOUNT',
        );
      }
      if (amount <= 0n) {
        return handleError(
          reply,
          400,
          'amountMist must be > 0',
          'BAD_AMOUNT',
        );
      }

      try {
        const tx = buildDepositTx(
          profile.balance_manager_id,
          profile.deposit_cap_id,
          amount,
          SUI_TYPE,
        );
        const executor = getExecutorKeypair();
        tx.setSender(executor.toSuiAddress());
        tx.setGasBudget(30_000_000);

        const result = (await suiGrpc.signAndExecuteTransaction({
          signer: executor,
          transaction: tx,
        })) as {
          Transaction?: {
            digest?: string;
            status?: { success?: boolean; error?: string | null };
          };
        };
        const inner = result.Transaction ?? {};
        if (inner.status && inner.status.success === false) {
          throw new Error(
            `deposit tx failed: ${inner.status.error ?? 'unknown'}`,
          );
        }
        if (!inner.digest) {
          throw new Error('deposit tx returned no digest');
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: { digest: inner.digest },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // POST /agent/pending-deposit
  //
  // Creates a deposit intent row. User will send SUI to the executor address
  // out-of-band; the autoDepositSweeper worker detects it and calls
  // deposit_with_cap server-side, then updates this row to 'swept'.
  //
  // Body: { amountMist: string }
  // Returns: { id, status, expectedBy, executorAddress }
  app.post(
    '/pending-deposit',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id || !user?.sui_address) {
        // sui_address is required so the sweeper can verify the inbound
        // transfer's sender matches this user (C2 fix).
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      const body = (request.body ?? {}) as { amountMist?: string };
      if (!body.amountMist) {
        return handleValidationError(reply, ['amountMist']);
      }
      let amount: bigint;
      try {
        amount = BigInt(body.amountMist);
        if (amount <= 0n) throw new Error('must be > 0');
      } catch {
        return handleError(reply, 400, 'amountMist must be a positive BigInt string', 'BAD_AMOUNT');
      }

      // 30-minute window; sweeper checks expected_by and skips expired rows.
      const expectedBy = new Date(Date.now() + 30 * 60 * 1000);
      try {
        const row = await prismaQuery.pendingDeposit.create({
          data: {
            trader_profile_id: user.trader_profile_id,
            amount_mist: amount,
            expected_by: expectedBy,
            status: 'awaiting',
            // Pin the expected sender. The sweeper only matches inbound
            // SUI to this row if the on-chain tx sender equals this address.
            expected_sender_address: user.sui_address,
          },
        });
        const executorAddress = getExecutorKeypair().toSuiAddress();
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            id: row.id,
            status: row.status,
            amountMist: row.amount_mist.toString(),
            expectedBy: row.expected_by.toISOString(),
            executorAddress,
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  // GET /agent/pending-deposits
  //
  // Returns all pending deposit intents for the authenticated user, newest first.
  // The web polls this every 5s to track swept status.
  app.get(
    '/pending-deposits',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.trader_profile_id) {
        return handleError(reply, 401, 'no profile bound', 'NO_PROFILE');
      }
      try {
        const rows = await prismaQuery.pendingDeposit.findMany({
          where: { trader_profile_id: user.trader_profile_id },
          orderBy: { created_at: 'desc' },
          take: 20,
        });
        return reply.code(200).send({
          success: true,
          error: null,
          data: rows.map((r) => ({
            id: r.id,
            status: r.status,
            amountMist: r.amount_mist.toString(),
            expectedBy: r.expected_by.toISOString(),
            sweptTxDigest: r.swept_tx_digest ?? null,
            createdAt: r.created_at.toISOString(),
          })),
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
