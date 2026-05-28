/**
 * POST /sponsor/dry-run
 *
 * Generic dry-run endpoint that builds any sponsored PTB and runs
 * `devInspectTransactionBlock` against testnet RPC. Returns the simulated
 * effects (gas estimate, status, events) WITHOUT executing on-chain.
 *
 * The discriminator `target` selects which builder to invoke. Body shape
 * mirrors the real sponsored route for that target, minus the JWT (sender
 * is taken from the authenticated session).
 *
 * Currently supports:
 *   - memory-write          (profile update + audit anchor)
 *   - revoke-agent          (executor::revoke + audit anchor)
 *   - predict-mint          (market_key + predict::mint + audit anchor)
 *   - predict-redeem        (market_key + predict::redeem + audit anchor)
 *   - predict-deposit       (predict_manager::deposit)
 *   - predict-supply        (predict::supply)
 *   - predict-withdraw      (predict::withdraw)
 *   - predict-onboard       (predict::create_manager)
 *
 * For `place-limit` use the existing `/sponsor/dry-run-place-limit` (more
 * specialised, includes Guardian freshness checks).
 *
 * Why dry-run BEFORE sign?
 *   - Show the user the gas cost
 *   - Catch out-of-budget / pool-not-whitelisted / expired aborts
 *     up-front with a typed `errorCode` instead of a generic 'Sponsor
 *     execute failed'
 *   - Verify the Move call resolves (catches stale env config)
 *   - Sanity-check object IDs exist on chain
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { Transaction } from '@mysten/sui/transactions';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { suiRpc } from '../lib/sui.ts';
import { buildMemoryWriteWithProofTx, buildRevokeAgentWithProofTx } from '../lib/lighthouseTxs.ts';
import {
  buildCreatePredictManagerTx,
  buildPredictDepositTx,
  buildPredictMintTx,
  buildPredictRedeemTx,
  buildPredictSupplyTx,
  buildPredictWithdrawTx,
} from '../lib/predict.ts';
import {
  handleError,
  handleServerError,
  handleValidationError,
} from '../utils/errorHandler.ts';

type DryRunTarget =
  | 'memory-write'
  | 'revoke-agent'
  | 'predict-onboard'
  | 'predict-deposit'
  | 'predict-mint'
  | 'predict-redeem'
  | 'predict-supply'
  | 'predict-withdraw';

interface DryRunBody {
  target?: DryRunTarget;
  /// Builder-specific args.
  args?: Record<string, unknown>;
}

const KNOWN_TARGETS: ReadonlySet<DryRunTarget> = new Set([
  'memory-write',
  'revoke-agent',
  'predict-onboard',
  'predict-deposit',
  'predict-mint',
  'predict-redeem',
  'predict-supply',
  'predict-withdraw',
]);

/**
 * Decode a hex (no 0x prefix) string to a Uint8Array. Throws on bad input.
 */
function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('expected even-length hex string');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function dispatchBuilder(target: DryRunTarget, args: Record<string, unknown>): Transaction {
  const a = args as Record<string, string | number | boolean | undefined>;
  switch (target) {
    case 'memory-write':
      return buildMemoryWriteWithProofTx({
        profileObjectId: String(a.profileObjectId),
        slice: String(a.slice),
        blobIdBytes: hexToBytes(String(a.blobIdHex)),
        kind: a.kind == null ? 0 : Number(a.kind),
      });
    case 'revoke-agent':
      return buildRevokeAgentWithProofTx({
        executorAgentId: String(a.executorAgentId),
        balanceManagerId: String(a.balanceManagerId),
        revocationBlobIdBytes: hexToBytes(String(a.reasonBlobIdHex)),
      });
    case 'predict-onboard':
      return buildCreatePredictManagerTx();
    case 'predict-deposit':
      return buildPredictDepositTx({
        managerObjectId: String(a.managerObjectId),
        coinObjectId: String(a.coinObjectId),
        coinTypeTag: String(a.coinTypeTag),
      });
    case 'predict-mint':
      return buildPredictMintTx({
        predictObjectId: String(a.predictObjectId),
        managerObjectId: String(a.managerObjectId),
        oracleObjectId: String(a.oracleObjectId),
        quoteTypeTag: String(a.quoteTypeTag),
        oracleId: String(a.oracleId),
        expiryMs: BigInt(String(a.expiryMs)),
        strike: BigInt(String(a.strike)),
        isUp: !!a.isUp,
        quantity: BigInt(String(a.quantity)),
        auditWalrusBlobIdBytes: a.auditWalrusBlobIdHex
          ? hexToBytes(String(a.auditWalrusBlobIdHex))
          : undefined,
      });
    case 'predict-redeem':
      return buildPredictRedeemTx({
        predictObjectId: String(a.predictObjectId),
        managerObjectId: String(a.managerObjectId),
        oracleObjectId: String(a.oracleObjectId),
        quoteTypeTag: String(a.quoteTypeTag),
        oracleId: String(a.oracleId),
        expiryMs: BigInt(String(a.expiryMs)),
        strike: BigInt(String(a.strike)),
        isUp: !!a.isUp,
        quantity: BigInt(String(a.quantity)),
        auditWalrusBlobIdBytes: a.auditWalrusBlobIdHex
          ? hexToBytes(String(a.auditWalrusBlobIdHex))
          : undefined,
      });
    case 'predict-supply':
      return buildPredictSupplyTx({
        predictObjectId: String(a.predictObjectId),
        coinObjectId: String(a.coinObjectId),
        quoteTypeTag: String(a.quoteTypeTag),
        recipient: String(a.recipient),
      });
    case 'predict-withdraw':
      return buildPredictWithdrawTx({
        predictObjectId: String(a.predictObjectId),
        lpCoinObjectId: String(a.lpCoinObjectId),
        quoteTypeTag: String(a.quoteTypeTag),
        recipient: String(a.recipient),
      });
  }
}

export const dryRunRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/dry-run',
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user;
      if (!user?.sui_address) {
        return handleError(reply, 401, 'no sui_address', 'NO_SUI_ADDRESS');
      }
      const body = (request.body ?? {}) as DryRunBody;
      if (!body.target) return handleValidationError(reply, ['target']);
      if (!KNOWN_TARGETS.has(body.target)) {
        return handleError(
          reply,
          400,
          `unknown dry-run target '${body.target}'`,
          'UNKNOWN_TARGET',
        );
      }
      if (!body.args || typeof body.args !== 'object') {
        return handleValidationError(reply, ['args']);
      }

      let tx: Transaction;
      try {
        tx = dispatchBuilder(body.target, body.args);
      } catch (e) {
        return handleError(
          reply,
          400,
          `failed to build PTB: ${(e as Error).message}`,
          'BUILD_FAILED',
        );
      }

      try {
        const txBytes = await tx.build({
          client: suiRpc as never,
          onlyTransactionKind: true,
        });
        const result = (await suiRpc.devInspectTransactionBlock({
          sender: user.sui_address,
          transactionBlock: Buffer.from(txBytes).toString('base64'),
        })) as unknown as {
          effects?: {
            status?: { status?: string; error?: string };
            gasUsed?: Record<string, string>;
          };
          events?: unknown[];
          results?: unknown[];
        };
        const status = result?.effects?.status?.status;
        const success = status === 'success';
        const gas = result?.effects?.gasUsed;
        const netGas = gas
          ? BigInt(gas.computationCost ?? '0') +
            BigInt(gas.storageCost ?? '0') -
            BigInt(gas.storageRebate ?? '0')
          : 0n;
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            target: body.target,
            willSucceed: success,
            status,
            errorCode: success ? null : result?.effects?.status?.error,
            gasUsed: gas,
            netGasMist: netGas.toString(),
            netGasSui: (Number(netGas) / 1e9).toFixed(6),
            eventsCount: result?.events?.length ?? 0,
            commandCount: result?.results?.length ?? 0,
            note: 'devInspect simulation only. Real execution may differ if on-chain state changes between dry-run and sign.',
          },
        });
      } catch (e) {
        return handleServerError(reply, e as Error);
      }
    },
  );

  done();
};
