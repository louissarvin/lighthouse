/**
 * DeepBook Predict PTB builders (Enoki-sponsored).
 *
 * Branch deployed on testnet: `predict-testnet-4-16` (verified 2026-06-18).
 * User-facing module: `deepbook_predict::predict`.
 *
 * Entry points exposed by the deployed package:
 *   create_manager(ctx): ID
 *     Creates a PredictManager owned by ctx.sender(). Returns the new ID.
 *
 *   mint<Quote>(predict, manager, oracle, key, quantity, clock, ctx)
 *     Place a prediction. Quote currency on testnet is DUSDC.
 *
 *   redeem<Quote>(predict, manager, oracle, key, quantity, clock, ctx)
 *     Claim winnings after market settles.
 *
 *   supply<Quote>(predict, coin, clock, ctx): Coin<PLP>
 *     Provide liquidity; receive PLP LP tokens.
 *
 *   predict_manager::deposit<T>(self, coin, ctx)
 *     Fund the manager with quote currency.
 *
 * Testnet object IDs (from docs.sui.io/onchain-finance/deepbook-predict):
 *   PREDICT_PACKAGE_ID  0xf5ea2b…  (matches our env)
 *   PREDICT_REGISTRY_ID 0x43af14fe (matches our env)
 *   PREDICT_OBJECT_ID   0xc8736204… (the shared Predict<DUSDC> object — NEW)
 *   DUSDC type tag      0xe9504008…::dusdc::DUSDC
 *
 * For v1 we expose ONLY onboarding (`predict::create_manager`) since the
 * Predict object reference + DUSDC funding paths require additional env
 * config. The infra below is the foundation; add mint/redeem/supply
 * wrappers when the predict feature lights up.
 *
 * SECURITY: `create_manager` is harmless to sponsor — the caller gets a
 * fresh empty PredictManager owned by the caller's address.
 */

import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import {
  LIGHTHOUSE_PACKAGE_ID,
  LIGHTHOUSE_VERSION_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
} from '../config/main-config.ts';

function assertConfigured(): void {
  if (!PREDICT_PACKAGE_ID) {
    throw new Error('[predict] PREDICT_PACKAGE_ID is not set');
  }
}

/**
 * Build a PTB calling `predict::create_manager(ctx): ID`.
 *
 * Creates a fresh PredictManager owned by the signer. The Move function
 * auto-handles object creation and returns the new manager's ID. To later
 * deposit/withdraw, the user calls `predict_manager::deposit<T>` and
 * `predict_manager::withdraw<T>` (separate PTBs).
 *
 * Caller: user. Sponsor: Coach (via Enoki). User signs once.
 */
export function buildCreatePredictManagerTx(): Transaction {
  assertConfigured();
  const tx = new Transaction();
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::create_manager`,
    arguments: [],
  });
  return tx;
}

// ─── deposit: fund a PredictManager with quote-currency coin ────────────────
//
// public fun predict_manager::deposit<T>(self, coin, ctx)
//
// User signs (PredictManager.owner == sender). Sponsorable via Enoki.

export interface PredictDepositArgs {
  /// PredictManager object id (shared).
  managerObjectId: string;
  /// Coin object id of currency T to deposit. Must be owned by sender.
  coinObjectId: string;
  /// Move type tag of T, e.g. the testnet DUSDC tag.
  coinTypeTag: string;
}

export function buildPredictDepositTx(args: PredictDepositArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    typeArguments: [args.coinTypeTag],
    arguments: [tx.object(args.managerObjectId), tx.object(args.coinObjectId)],
  });
  return tx;
}

// ─── mint: place a prediction ──────────────────────────────────────────────
//
// public fun predict::mint<Quote>(
//   predict: &mut Predict,
//   manager: &mut PredictManager,
//   oracle: &OracleSVI,
//   key: MarketKey,
//   quantity: u64,
//   clock: &Clock,
//   ctx: &mut TxContext,
// )
//
// MarketKey is constructed inline via market_key::up / down / new, then
// passed by value to mint. We use market_key::new(oracle_id, expiry,
// strike, is_up): MarketKey which covers both directions in one helper.

export interface PredictMintArgs {
  /// Predict shared object id (per quote currency on testnet).
  predictObjectId: string;
  /// User's PredictManager id (shared).
  managerObjectId: string;
  /// OracleSVI shared object id (per underlying asset).
  oracleObjectId: string;
  /// Move type tag of Quote currency (e.g. DUSDC).
  quoteTypeTag: string;
  /// MarketKey scalar fields.
  oracleId: string;       // address — usually equals oracleObjectId
  expiryMs: bigint;       // u64 — expiry timestamp in ms
  strike: bigint;         // u64 — strike price
  isUp: boolean;          // true for "up", false for "down" prediction
  /// Position quantity (u64, in DUSDC raw units = 1e6 per dollar).
  quantity: bigint;
  /// OPTIONAL: bundle an audit anchor (kind=1 trade) in the same atomic PTB.
  /// Pass the Walrus blob id bytes for the off-chain trade rationale.
  /// When set, the entire mint+anchor flow is one PTB → cannot be split.
  auditWalrusBlobIdBytes?: Uint8Array;
}

export function buildPredictMintTx(args: PredictMintArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();

  // 1. Build the MarketKey via market_key::new.
  const [marketKey] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::new`,
    arguments: [
      tx.pure(bcs.Address.serialize(args.oracleId).toBytes()),
      tx.pure(bcs.U64.serialize(args.expiryMs).toBytes()),
      tx.pure(bcs.U64.serialize(args.strike).toBytes()),
      tx.pure(bcs.Bool.serialize(args.isUp).toBytes()),
    ],
  });

  // 2. Call predict::mint<Quote>(predict, manager, oracle, key, qty, clock).
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::mint`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.object(args.predictObjectId),
      tx.object(args.managerObjectId),
      tx.object(args.oracleObjectId),
      marketKey,
      tx.pure(bcs.U64.serialize(args.quantity).toBytes()),
      tx.object('0x6'),
    ],
  });

  // 3. OPTIONAL: bundle audit anchor for the prediction event (kind=1).
  if (args.auditWalrusBlobIdBytes) {
    if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID) {
      throw new Error('[predict] LIGHTHOUSE package + version object required for audit anchor');
    }
    if (args.auditWalrusBlobIdBytes.length === 0) {
      throw new Error('[predict] auditWalrusBlobIdBytes must be non-empty');
    }
    const [anchor] = tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
      arguments: [
        tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
        tx.pure(bcs.U8.serialize(1).toBytes()), // kind=1 trade
        tx.pure(
          bcs.vector(bcs.U8).serialize(Array.from(args.auditWalrusBlobIdBytes)).toBytes(),
        ),
        tx.pure(bcs.vector(bcs.U8).serialize(Array.from(new Uint8Array(32))).toBytes()),
        tx.object('0x6'),
      ],
    });
    tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
      arguments: [anchor],
    });
  }

  return tx;
}

// ─── redeem: claim winnings on a settled MarketKey ─────────────────────────
//
// public fun predict::redeem<Quote>(
//   predict: &mut Predict,
//   manager: &mut PredictManager,
//   oracle: &OracleSVI,
//   key: MarketKey,
//   quantity: u64,
//   clock: &Clock,
//   ctx: &mut TxContext,
// )
//
// User-signed (PredictManager.owner == sender). Mirrors mint with
// optional audit anchor (kind=1 trade — redemption is a closing trade).

export type PredictRedeemArgs = PredictMintArgs;

export function buildPredictRedeemTx(args: PredictRedeemArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();

  const [marketKey] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::new`,
    arguments: [
      tx.pure(bcs.Address.serialize(args.oracleId).toBytes()),
      tx.pure(bcs.U64.serialize(args.expiryMs).toBytes()),
      tx.pure(bcs.U64.serialize(args.strike).toBytes()),
      tx.pure(bcs.Bool.serialize(args.isUp).toBytes()),
    ],
  });

  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::redeem`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.object(args.predictObjectId),
      tx.object(args.managerObjectId),
      tx.object(args.oracleObjectId),
      marketKey,
      tx.pure(bcs.U64.serialize(args.quantity).toBytes()),
      tx.object('0x6'),
    ],
  });

  if (args.auditWalrusBlobIdBytes) {
    if (!LIGHTHOUSE_PACKAGE_ID || !LIGHTHOUSE_VERSION_OBJECT_ID) {
      throw new Error('[predict] LIGHTHOUSE package + version object required for audit anchor');
    }
    if (args.auditWalrusBlobIdBytes.length === 0) {
      throw new Error('[predict] auditWalrusBlobIdBytes must be non-empty');
    }
    const [anchor] = tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::record`,
      arguments: [
        tx.object(LIGHTHOUSE_VERSION_OBJECT_ID),
        tx.pure(bcs.U8.serialize(1).toBytes()),
        tx.pure(
          bcs.vector(bcs.U8).serialize(Array.from(args.auditWalrusBlobIdBytes)).toBytes(),
        ),
        tx.pure(bcs.vector(bcs.U8).serialize(Array.from(new Uint8Array(32))).toBytes()),
        tx.object('0x6'),
      ],
    });
    tx.moveCall({
      target: `${LIGHTHOUSE_PACKAGE_ID}::audit_anchor::transfer_to_owner`,
      arguments: [anchor],
    });
  }

  return tx;
}

// ─── supply: provide liquidity, receive PLP LP tokens ────────────────────────
//
// public fun predict::supply<Quote>(
//   predict: &mut Predict,
//   coin: Coin<Quote>,
//   clock: &Clock,
//   ctx: &mut TxContext,
// ): Coin<PLP>
//
// Returns Coin<PLP> by value. The PTB transfers it to sender so the user
// ends up holding LP tokens against the prediction-market vault.

export interface PredictSupplyArgs {
  /// Predict shared object id (per quote currency on testnet).
  predictObjectId: string;
  /// Coin object id of Quote currency to supply.
  coinObjectId: string;
  /// Move type tag of Quote currency (e.g. DUSDC).
  quoteTypeTag: string;
  /// Sui address that should receive the resulting Coin<PLP>. Usually equals
  /// `ctx.sender()`, but passed explicitly so the PTB can transfer it.
  recipient: string;
}

export function buildPredictSupplyTx(args: PredictSupplyArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();
  const [lpCoin] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::supply`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.object(args.predictObjectId),
      tx.object(args.coinObjectId),
      tx.object('0x6'),
    ],
  });
  tx.transferObjects([lpCoin], tx.pure.address(args.recipient));
  return tx;
}

// ─── withdraw: burn PLP LP tokens, receive Quote back ─────────────────────────
//
// public fun predict::withdraw<Quote>(
//   predict: &mut Predict,
//   lp_coin: Coin<PLP>,
//   clock: &Clock,
//   ctx: &mut TxContext,
// ): Coin<Quote>
//
// Inverse of supply. User burns PLP, gets Quote currency back, PTB
// transfers it to the recipient.

export interface PredictWithdrawArgs {
  /// Predict shared object id.
  predictObjectId: string;
  /// Coin<PLP> object id to burn.
  lpCoinObjectId: string;
  /// Move type tag of Quote currency.
  quoteTypeTag: string;
  /// Recipient of the returned Coin<Quote>.
  recipient: string;
}

export function buildPredictWithdrawTx(args: PredictWithdrawArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();
  const [quoteCoin] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::withdraw`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.object(args.predictObjectId),
      tx.object(args.lpCoinObjectId),
      tx.object('0x6'),
    ],
  });
  tx.transferObjects([quoteCoin], tx.pure.address(args.recipient));
  return tx;
}

// ─── Active market discovery ─────────────────────────────────────────────────
//
// Pulls active binary-option markets from the predict server and verifies each
// oracle object exists on-chain (capturing its `initialSharedVersion` for PTB
// reference building). Results are cached for 30s to avoid hammering the RPC
// on rapid Telegram interactions.

/// Verified active prediction market ready for PTB construction.
export interface PredictMarket {
  /// Predict shared object id (per quote currency, e.g. DUSDC on testnet).
  predictId: string;
  /// OracleSVI shared object id (per underlying asset).
  oracleId: string;
  /// Underlying asset ticker as reported by predict server (e.g. "BTC").
  underlyingAsset: string;
  /// Market expiry timestamp in unix ms.
  expiryMs: number;
  /// Minimum strike (nano-USD, scaled 1e9).
  minStrike: bigint;
  /// Tick size for strike spacing (nano-USD).
  tickSize: bigint;
  /// Oracle's `initialSharedVersion` from sui_getObject, required to encode
  /// the shared-object reference inside a Programmable Transaction Block.
  oracleInitialSharedVersion: number;
  /// Current spot price from the oracle (nano-USD, scaled 1e9). Used to
  /// derive the ATM strike — passing `min_strike` instead aborts the SVI
  /// pricing model when spot is far from the floor.
  spotPrice: bigint;
}

interface PredictServerOracle {
  predict_id: string;
  oracle_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: string | number;
  tick_size: string | number;
  status: string;
}

interface MarketsCache {
  markets: PredictMarket[];
  fetchedAt: number;
}

let marketsCache: MarketsCache | null = null;
const ORACLE_CACHE_TTL_MS = 30_000;

/**
 * Fetch up to 3 verified active prediction markets, sorted by nearest expiry.
 * Cached for 30s. Verifies each candidate oracle exists on-chain via JSON-RPC
 * and captures its `initialSharedVersion` for PTB shared-object references.
 *
 * Throws on network/parse failure (caller renders a user-friendly error).
 */
export async function getActiveMarkets(
  predictServerUrl: string,
  suiRpcUrl: string,
): Promise<PredictMarket[]> {
  if (marketsCache && Date.now() - marketsCache.fetchedAt < ORACLE_CACHE_TTL_MS) {
    return marketsCache.markets;
  }

  // 1. Pull oracle list from predict server (5s timeout).
  const url = `${predictServerUrl.replace(/\/$/, '')}/oracles`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) {
    throw new Error(`[predict] oracles endpoint ${resp.status}: ${resp.statusText}`);
  }
  const raw = (await resp.json()) as PredictServerOracle[];
  if (!Array.isArray(raw)) {
    throw new Error('[predict] oracles endpoint returned non-array');
  }

  // 2. Filter to active markets with at least 60s of buffer before expiry.
  const now = Date.now();
  const candidates = raw
    .filter((m) => m.status === 'active' && m.expiry > now + 60_000)
    .sort((a, b) => a.expiry - b.expiry)
    .slice(0, 5);

  // 3. For each candidate, verify the oracle object exists on-chain and grab
  //    its initialSharedVersion. Bail out early once we have 3 valid markets.
  const verified: PredictMarket[] = [];
  for (const m of candidates) {
    if (verified.length >= 3) break;
    try {
      const oracleData = await fetchOracleData(suiRpcUrl, m.oracle_id);
      if (oracleData === null) continue;
      verified.push({
        predictId: m.predict_id,
        oracleId: m.oracle_id,
        underlyingAsset: m.underlying_asset,
        expiryMs: m.expiry,
        minStrike: BigInt(m.min_strike),
        tickSize: BigInt(m.tick_size),
        oracleInitialSharedVersion: oracleData.initialSharedVersion,
        spotPrice: oracleData.spotPrice,
      });
    } catch (e) {
      console.warn(`[predict] oracle ${m.oracle_id} verify failed:`, (e as Error).message);
    }
  }

  marketsCache = { markets: verified, fetchedAt: Date.now() };
  return verified;
}

interface SuiGetObjectResult {
  result?: {
    data?: {
      objectId?: string;
      owner?: { Shared?: { initial_shared_version?: number | string } } | string;
    };
  };
  error?: unknown;
}

/**
 * Fetch the `initialSharedVersion` for a shared object via sui_getObject.
 * Returns null if the object is not shared or not found. 3s timeout.
 *
 * Internal helper for getActiveMarkets and predict manager bootstrapping.
 */
export async function fetchInitialSharedVersion(
  suiRpcUrl: string,
  objectId: string,
): Promise<number | null> {
  const resp = await fetch(suiRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getObject',
      params: [objectId, { showOwner: true, showType: true }],
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as SuiGetObjectResult;
  if (data.error || !data.result?.data?.objectId) return null;
  const owner = data.result.data.owner;
  if (!owner || typeof owner === 'string') return null;
  const isv = owner.Shared?.initial_shared_version;
  if (isv === undefined || isv === null) return null;
  return Number(isv);
}

export interface OracleOnChainData {
  initialSharedVersion: number;
  spotPrice: bigint;
}

export async function fetchOracleData(
  suiRpcUrl: string,
  oracleId: string,
): Promise<OracleOnChainData | null> {
  const resp = await fetch(suiRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getObject',
      params: [oracleId, { showOwner: true, showType: true, showContent: true }],
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    result?: {
      data?: {
        objectId?: string;
        owner?: { Shared?: { initial_shared_version?: number | string } } | string;
        content?: {
          fields?: {
            prices?: {
              fields?: { spot?: string | number };
            };
          };
        };
      };
    };
    error?: unknown;
  };
  if (data.error || !data.result?.data?.objectId) return null;
  const owner = data.result.data.owner;
  if (!owner || typeof owner === 'string') return null;
  const isv = owner.Shared?.initial_shared_version;
  if (isv === undefined || isv === null) return null;
  const spot = data.result.data.content?.fields?.prices?.fields?.spot;
  if (spot === undefined || spot === null) return null;
  return {
    initialSharedVersion: Number(isv),
    spotPrice: BigInt(spot),
  };
}

/// Initial shared version of the Predict<DUSDC> shared object on testnet.
/// Captured on-chain at the v3 deploy (2026-06-19). Constant for the lifetime
/// of the deployed package; never rotates without a redeploy.
export const PREDICT_OBJECT_INITIAL_SHARED_VERSION = 829857685;

/**
 * Fetch the oracle's on-chain `expiry` field (u64 unix ms) via sui_getObject.
 * Returns null if the oracle object is not found or the field is missing. 5s timeout.
 *
 * Used to lazily resolve `expiryMs` for old HedgePosition rows that were
 * created before the `expiry_ms` column was added to the schema.
 */
export async function fetchOracleExpiry(
  suiRpcUrl: string,
  oracleObjectId: string,
): Promise<bigint | null> {
  const resp = await fetch(suiRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getObject',
      params: [oracleObjectId, { showContent: true }],
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    result?: {
      data?: {
        content?: {
          fields?: { expiry?: string | number | null };
        };
      };
    };
    error?: unknown;
  };
  if (data.error) return null;
  const expiry = data.result?.data?.content?.fields?.expiry;
  if (expiry === undefined || expiry === null) return null;
  try {
    return BigInt(expiry);
  } catch {
    return null;
  }
}

// ─── Combined deposit + mint (executor-signed) ───────────────────────────────
//
// One atomic PTB that:
//   1. splits `quantity` DUSDC off an executor-owned coin
//   2. deposits the split into the user's PredictManager
//   3. constructs the MarketKey via market_key::new
//   4. calls predict::mint<DUSDC> to place the binary position
//
// All shared-object references are encoded explicitly with
// `sharedObjectRef({ objectId, initialSharedVersion, mutable })` because the
// executor signs (no Enoki sponsor here) and we need deterministic input
// resolution against testnet's `loadedChildObjects` requirements.

export interface ExecutorMintArgs {
  predictObjectId: string;
  predictObjectInitialSharedVersion: number;
  predictManagerId: string;
  predictManagerInitialSharedVersion: number;
  oracleObjectId: string;
  oracleInitialSharedVersion: number;
  /// Market expiry (unix ms). Must match the on-chain oracle market exactly.
  expiryMs: bigint;
  /// Strike price (nano-USD raw units).
  strike: bigint;
  /// true = UP position, false = DOWN position.
  isUp: boolean;
  /// Position quantity in DUSDC raw units (1e6 per dollar).
  quantity: bigint;
  /// DUSDC coin owned by the executor used to fund the manager deposit.
  dusdcCoinObjectId: string;
  dusdcCoinVersion: string;
  dusdcCoinDigest: string;
  /// Quote currency Move type tag (e.g. testnet DUSDC).
  quoteTypeTag: string;
}

export function buildExecutorPredictMintTx(args: ExecutorMintArgs): Transaction {
  assertConfigured();
  const tx = new Transaction();

  // 1. Split exact quantity off the executor's DUSDC coin.
  const [depositCoin] = tx.splitCoins(
    tx.objectRef({
      objectId: args.dusdcCoinObjectId,
      version: args.dusdcCoinVersion,
      digest: args.dusdcCoinDigest,
    }),
    [tx.pure.u64(args.quantity)],
  );

  // 2. Deposit into the user's PredictManager.
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.sharedObjectRef({
        objectId: args.predictManagerId,
        initialSharedVersion: args.predictManagerInitialSharedVersion,
        mutable: true,
      }),
      depositCoin,
    ],
  });

  // 3. Build the MarketKey.
  const [marketKey] = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::new`,
    arguments: [
      tx.pure.id(args.oracleObjectId),
      tx.pure.u64(args.expiryMs),
      tx.pure.u64(args.strike),
      tx.pure.bool(args.isUp),
    ],
  });

  // 4. Mint the binary position.
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::mint`,
    typeArguments: [args.quoteTypeTag],
    arguments: [
      tx.sharedObjectRef({
        objectId: args.predictObjectId,
        initialSharedVersion: args.predictObjectInitialSharedVersion,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: args.predictManagerId,
        initialSharedVersion: args.predictManagerInitialSharedVersion,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: args.oracleObjectId,
        initialSharedVersion: args.oracleInitialSharedVersion,
        mutable: false,
      }),
      marketKey,
      tx.pure.u64(args.quantity),
      tx.object('0x6'),
    ],
  });

  return tx;
}

/**
 * The Move call targets that the Enoki sponsor whitelist must include to
 * support user-facing Predict actions. Returned as a flat string array so
 * `lib/enoki.ts::getAllowedMoveCallTargets()` can concat them in.
 */
export function getPredictAllowedMoveCallTargets(): string[] {
  if (!PREDICT_PACKAGE_ID) return [];
  return [
    `${PREDICT_PACKAGE_ID}::predict::create_manager`,
    `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    `${PREDICT_PACKAGE_ID}::predict::mint`,
    `${PREDICT_PACKAGE_ID}::predict::redeem`,
    `${PREDICT_PACKAGE_ID}::predict::supply`,
    `${PREDICT_PACKAGE_ID}::predict::withdraw`,
    // `market_key::new` is invoked transitively inside mint/redeem PTBs but
    // each tx call still needs an explicit whitelist entry under Enoki's
    // policy enforcement model.
    `${PREDICT_PACKAGE_ID}::market_key::new`,
  ];
}

/**
 * Query the DUSDC available balance inside a user's PredictManager.
 *
 * PredictManager internal structure (verified on testnet):
 *   PredictManager.balance_manager (BalanceManager)
 *     .balances (Bag)
 *       → dynamic fields: BalanceKey<DUSDC> → Balance<DUSDC> { value: u64 }
 *
 * We walk: PM object → Bag ID → suix_getDynamicFields → balance object → value.
 */
export async function getPredictManagerDusdcBalance(
  suiRpcUrl: string,
  predictManagerId: string,
): Promise<{ dusdcRaw: bigint; positionCount: number }> {
  try {
    // Step 1: fetch PredictManager object
    const pmResp = await fetch(suiRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getObject',
        params: [predictManagerId, { showContent: true }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!pmResp.ok) return { dusdcRaw: 0n, positionCount: 0 };
    const pmData = (await pmResp.json()) as {
      result?: {
        data?: {
          content?: {
            fields?: {
              positions?: { fields?: { size?: string | number } };
              balance_manager?: {
                fields?: {
                  balances?: { fields?: { id?: { id?: string } } };
                };
              };
            };
          };
        };
      };
    };
    const fields = pmData?.result?.data?.content?.fields;
    const positionCount = Number(fields?.positions?.fields?.size ?? 0);
    const bagId = fields?.balance_manager?.fields?.balances?.fields?.id?.id;
    if (!bagId) return { dusdcRaw: 0n, positionCount };

    // Step 2: list dynamic fields of the Bag (each entry = one coin type)
    const bagResp = await fetch(suiRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_getDynamicFields',
        params: [bagId, null, 20],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!bagResp.ok) return { dusdcRaw: 0n, positionCount };
    const bagData = (await bagResp.json()) as {
      result?: {
        data?: Array<{
          name?: { type?: string };
          objectId?: string;
        }>;
      };
    };
    const dynFields = bagData?.result?.data ?? [];

    // Step 3: find the DUSDC entry and fetch its balance value
    let dusdcRaw = 0n;
    for (const field of dynFields) {
      const keyType = field?.name?.type ?? '';
      if (keyType.toLowerCase().includes('dusdc') && field.objectId) {
        const balResp = await fetch(suiRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sui_getObject',
            params: [field.objectId, { showContent: true }],
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (balResp.ok) {
          const balData = (await balResp.json()) as {
            result?: { data?: { content?: { fields?: { value?: string | number } } } };
          };
          const val = balData?.result?.data?.content?.fields?.value;
          if (val !== undefined && val !== null) {
            dusdcRaw = BigInt(val);
          }
        }
        break;
      }
    }
    return { dusdcRaw, positionCount };
  } catch {
    return { dusdcRaw: 0n, positionCount: 0 };
  }
}

/**
 * Query SUI and DUSDC balances held directly at a Sui address (wallet coins).
 * Uses suix_getAllBalances which aggregates across all coin objects.
 */
export async function getWalletBalances(
  suiRpcUrl: string,
  address: string,
  dusdcTypeTag: string,
): Promise<{ suiRaw: bigint; dusdcRaw: bigint }> {
  try {
    const resp = await fetch(suiRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_getAllBalances',
        params: [address],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { suiRaw: 0n, dusdcRaw: 0n };
    const data = (await resp.json()) as {
      result?: Array<{ coinType?: string; totalBalance?: string }>;
    };
    const balances = data?.result ?? [];
    let suiRaw = 0n;
    let dusdcRaw = 0n;
    for (const b of balances) {
      if (b.coinType === '0x2::sui::SUI') suiRaw = BigInt(b.totalBalance ?? '0');
      if (b.coinType === dusdcTypeTag) dusdcRaw = BigInt(b.totalBalance ?? '0');
    }
    return { suiRaw, dusdcRaw };
  } catch {
    return { suiRaw: 0n, dusdcRaw: 0n };
  }
}
