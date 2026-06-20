/**
 * Backend response shape mirrors.
 *
 * Only the fields the web app consumes are typed; the backend may return
 * more. Stay conservative — adding new fields here is cheap, removing them
 * is breaking.
 */

export interface ProfileMe {
  traderProfileId: string
  suiAddress: string
  profileObjectId: string
  balanceManagerId: string | null
  executorAgentId: string | null
  depositCapId: string | null
  memwalAccountId: string | null
  predictManagerId?: string | null
  suinsName?: string | null
  coachGroupUuid?: string | null
  auditGroupUuid?: string | null
  createdAt?: string
  riskProfileCompletedAt: string | null
}

// ────────────────────────────────────────────────────────────────────────
// Risk profile onboarding
// ────────────────────────────────────────────────────────────────────────

export interface RiskQuestion {
  id: string
  prompt: string
  kind: string
}

export interface RiskQuestionsResponse {
  questions: Array<RiskQuestion>
}

export interface RiskProfileCompleteResponse {
  riskProfileCompletedAt: string
  memwalPersisted: boolean
  summary: {
    goal: string
    horizon: string
    drawdown: string
    markets: string
    leverage: string
  }
}

export interface ExecutorAgentSnapshot {
  agent_address: string
  owner_address: string
  balance_manager_id: string
  allowed_pools: Array<string>
  // / FLOAT_SCALING'd notional (1e9). String for BigInt-safe transport.
  max_notional_per_trade: string
  max_notional_per_day: string
  spent_today: string
  window_start_ms: string
  expires_at_ms: string
  revoked: boolean
}

export interface AgentSnapshotResponse {
  ready: boolean
  executor_agent_id?: string
  balance_manager_id?: string | null
  snapshot: ExecutorAgentSnapshot | null
}

export interface BookLevel {
  // / Human-decimal price (string).
  price: string
  // / Human-decimal base quantity.
  quantity: string
  // / Cumulative notional (price * sum(qty)).
  total: string
}

export interface OrderBookSnapshot {
  poolKey: string
  poolId: string
  base: string
  quote: string
  baseDecimals: number
  quoteDecimals: number
  mid: string | null
  bids: Array<BookLevel>
  asks: Array<BookLevel>
  lastUpdated: number
}

export interface SponsorBuildResponse {
  digest: string
  bytes: string
  note?: string
}

export type EventKind =
  | 'TraderProfileCreated'
  | 'MemWalWrite'
  | 'AnchorRecorded'
  | 'TradePlaced'
  | 'GrantCreated'

export interface ActivityEvent {
  kind: EventKind
  tx_digest: string
  timestamp_ms: number
  summary: string
  // / Stable Prisma cuid for the underlying Recommendation or Trade row,
  // / enabling deep-links to `/receipt/<id>`. Null when no backing record
  // / exists (e.g. pure audit anchors written outside the recommendation
  // / flow, MemWal writes, profile creation).
  receipt_id?: string | null
  receipt_kind?: 'recommendation' | 'trade' | null
}

export interface ActivityData {
  events: Array<ActivityEvent>
  total_indexed: number
}

export interface DryRunPlaceLimitResponse {
  willSucceed: boolean
  gasUsed?: string
  effects?: unknown
  events?: Array<{ type: string; message?: string }>
  errorMessage?: string
}

export interface PredictMarket {
  oracle_id: string
  symbol?: string
  strike: string
  expiry_ms: string
  mid_implied_up_bps?: number
  mid_implied_down_bps?: number
  predict_object_id?: string
  oracle_object_id?: string
  quote_type_tag?: string
  _note?: string
}

export interface PredictMarketsResponse {
  markets: Array<PredictMarket>
  source?: 'upstream' | 'stub'
  stale?: boolean
}

export interface TearsheetListItem {
  week: string
  walrus_blob_id: string
  publicTearsheetUrl?: string
  auditAnchorTxDigest?: string
  total_trades?: number
  window_from?: string
  window_to?: string
  createdAt?: string
}

// ────────────────────────────────────────────────────────────────────────
// Coach (Atoma + MemWal + Guardian)
// ────────────────────────────────────────────────────────────────────────

export interface CoachDecision {
  side: 'bid' | 'ask' | string
  pool: string
  // / Human-decimal price string (per coach orchestrator output).
  price: string
  // / Human-decimal base quantity string.
  quantity: string
  reasoning?: string
  expiry_ms?: number
  // / Optional: oracle id + side for an OTM hedge leg (Predict).
  hedge?: {
    oracleId?: string
    side: 'UP' | 'DOWN'
    quantity_dusdc?: string
  } | null
}

export interface GuardianCheck {
  name: string
  pass: boolean
  detail?: string
}

export interface GuardianResult {
  overall_pass: boolean
  summary: string
  checks?: Array<GuardianCheck>
}

export interface RecalledMemory {
  blobId: string
  text: string
  distance: number
  namespace?: string
}

export interface CoachRecommendResponse {
  recommendationId: string
  decision: CoachDecision
  guardian: GuardianResult
  recalledMemories: Array<RecalledMemory>
  atomaRequestHash: string
  atomaResponseHash?: string
  atomaModel: string
  atomaNodeSignature?: string
  walrusBlobId: string | null
  memwalBlobId: string | null
  auditAnchorTxDigest: string | null
  userAuditPtb: { digest: string; bytes: string } | null
}

// ────────────────────────────────────────────────────────────────────────
// Predict positions
// ────────────────────────────────────────────────────────────────────────

export type HedgePositionStatus = 'open' | 'settled' | 'lost' | 'redeemed'

export interface HedgePosition {
  id: string
  oracle_id: string
  predict_id: string | null
  is_up: boolean
  strike: string
  quantity: string
  expiry_ms: string | null
  tx_digest: string | null
  status: HedgePositionStatus
  settled_at: string | null
  created_at: string
}

// PredictPositionsResponse is declared canonically below near the
// PredictPosition type (used by /predict/positions-own). The HedgePosition
// interface above is kept for callers that consume the richer DB-shaped
// view (e.g. tearsheets).

// ────────────────────────────────────────────────────────────────────────
// Balance
// ────────────────────────────────────────────────────────────────────────

export interface PredictBalanceResponse {
  dusdc: string
  sui: string
  raw: {
    predictManager: { dusdc: string } | null
    suiGas: string
  }
}

// ────────────────────────────────────────────────────────────────────────
// MemWal namespaces + recall
// ────────────────────────────────────────────────────────────────────────

export interface MemWalNamespaceMeta {
  namespace: string
  label: string
  description: string
}

export interface MemWalNamespacesResponse {
  memwalAccountId: string | null
  delegateConfigured: boolean
  namespaces: Array<MemWalNamespaceMeta>
}

export interface MemWalRecallEntry {
  blobId: string
  text: string
  distance: number
  namespace?: string
}

export interface MemWalRecallResponse {
  query: string
  namespace: string | null
  results: Array<MemWalRecallEntry>
}

// ────────────────────────────────────────────────────────────────────────
// Public proof (receipt)
// ────────────────────────────────────────────────────────────────────────

export interface ProofAtoma {
  model: string
  endpoint: string
  requestHash: string
  responseHash?: string | null
  nodeSignature?: string | null
}

export interface ProofWalrus {
  blobId: string
  readUrl: string
}

export interface ProofSeal {
  packageId: string
  identityHex: string | null
  slice: string
}

export interface ProofLighthouse {
  packageId: string | null
  profileObjectId: string | null
  executorAgentId: string | null
  suiAddress: string
}

export interface ProofRecommendation {
  kind: 'recommendation'
  recommendationId: string
  createdAt: string
  atoma: ProofAtoma
  // / Either a fully-formed CoachDecision (guarded coach output) OR a synthetic
  // / chat-anchor shape `{ kind: 'chat-anchor', text, originalUserPrompt?, source? }`
  // / when produced by /coach/anchor-reply. The UI inspects `kind` first.
  decision:
    | CoachDecision
    | {
        kind: 'chat-anchor'
        text: string
        originalUserPrompt?: string | null
        source?: string
      }
  guardian: { pass: boolean; summary: string | null }
  seal: ProofSeal
  walrus: ProofWalrus | null
  // / Populated once EventIndexer links Recommendation.walrus_blob_id to the
  // / AnchorRecorded event's tx digest. Null while indexing catches up.
  sui?: { txDigest: string } | null
  lighthouse: ProofLighthouse
  verification: { instructions: string }
}

export interface ProofTrade {
  kind: 'trade'
  tradeId: string
  createdAt: string
  settledAt?: string | null
  status: string
  side: string
  pool: string
  orderId: string | null
  clientOrderId: string
  price: string
  quantity: string
  notional: string
  filledQuantity: string
  recommendation?: {
    id: string
    atomaRequestHash: string
    model: string
    endpoint: string
  } | null
  seal: ProofSeal
  walrus: ProofWalrus | null
  sui?: { txDigest: string } | null
  lighthouse: ProofLighthouse
}

export type ProofResponse = ProofRecommendation | ProofTrade

// ────────────────────────────────────────────────────────────────────────
// Public tearsheet
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// Public trader profile (GET /profile/by-suins/:name)
// ────────────────────────────────────────────────────────────────────────

export interface PublicProfileLatestTearsheet {
  week: string
  walrusBlobId: string
  auditAnchorTxDigest: string | null
  windowFrom: string
  windowTo: string
  totalTrades: number | null
  publicTearsheetUrl: string
}

export interface PublicProfileResponse {
  suinsName: string
  suiAddress: string
  profileObjectId: string
  balanceManagerId: string | null
  executorAgentId: string | null
  walrusSiteObjectId: string | null
  createdAt: string
  counts: {
    tradesPlaced: number
    // / Protocol-wide count of audit anchors recorded by Lighthouse (not
    // / scoped to this profile — the WalrusBlob table has no trader scope
    // / column today). Label this honestly in the UI.
    lighthouseAnchorsTotal: number
  }
  latestTearsheet: PublicProfileLatestTearsheet | null
}

export interface TearsheetResponse {
  week: string
  suins_name: string | null
  sui_address: string
  walrus_blob_id: string
  publicTearsheetUrl: string
  auditAnchorTxDigest: string | null
  window_from: string
  window_to: string
  total_trades: number | null
  total_notional_usdc: string | null
  distinct_pools: number | null
  disclaimer: string
  tearsheet: unknown
}

// ────────────────────────────────────────────────────────────────────────
// SuiNS resolve
// ────────────────────────────────────────────────────────────────────────

export interface SuiNSResolveResponse {
  name: string
  address: string | null
}

// ────────────────────────────────────────────────────────────────────────
// Sui Stack Messaging
// ────────────────────────────────────────────────────────────────────────

export interface MessagingHealth {
  enabled: boolean
  relayerUrl?: string
  reason?: string
}

// ────────────────────────────────────────────────────────────────────────
// Predict positions
// ────────────────────────────────────────────────────────────────────────

export interface PredictPosition {
  oracle_id: string
  predict_id: string | null
  strike: string
  is_up: boolean
  quantity: string
  status: 'open' | 'settled' | 'redeemed' | string
  expiry_ms?: number | null
  payout?: string | null
}

export interface PredictPositionsResponse {
  positions: Array<PredictPosition>
  stale?: boolean
  source?: string
}

// ────────────────────────────────────────────────────────────────────────
// MemWal bulk remember
// ────────────────────────────────────────────────────────────────────────

export interface MemWalRememberBulkItem {
  text: string
  namespace: string
}

export interface MemWalRememberBulkResult {
  blobId: string | null
  namespace: string
  status: string
}

// ────────────────────────────────────────────────────────────────────────
// Audit cap
// ────────────────────────────────────────────────────────────────────────

export interface AuditGrantResponse {
  digest: string
  bytes: string
  note?: string
}

// ────────────────────────────────────────────────────────────────────────
// Anchor reply
// ────────────────────────────────────────────────────────────────────────

export interface AnchorReplyResponse {
  recommendationId: string
  walrusBlobId: string
  walrusReadUrl: string
  auditAnchorTxDigest: string
  explorerUrl: string
  receiptUrl: string
}

// ────────────────────────────────────────────────────────────────────────
// DeepBook pool registry
// ────────────────────────────────────────────────────────────────────────

export interface DeepBookPool {
  poolKey: string
  poolId: string
  base: string
  quote: string
  baseType: string
  quoteType: string
  baseDecimals: number
  quoteDecimals: number
  label?: string
}

// ────────────────────────────────────────────────────────────────────────
// Messaging send
// ────────────────────────────────────────────────────────────────────────

export interface MessagingSendResponse {
  messageId: string
}

// ────────────────────────────────────────────────────────────────────────
// Predict P&L summary
// ────────────────────────────────────────────────────────────────────────

export interface PredictPnLResponse {
  open: number
  won: number
  lost: number
  redeemed: number
  winRate: number | null
  totalWageredDusdc: string
  streak: 'win_streak' | 'positive_run' | 'loss_streak' | 'negative_run' | null
}

// ────────────────────────────────────────────────────────────────────────
// Agent balances (BalanceManager + PredictManager + Wallet)
// ────────────────────────────────────────────────────────────────────────

export interface AgentBalancesResponse {
  balanceManager: {
    available: boolean
    objectId: string | null
    sui: string | null
    dbusdc: string | null
  }
  predictManager: {
    available: boolean
    objectId: string | null
    dusdc: string | null
    positionCount: number
  }
  wallet: {
    suiAddress: string
    sui: string
    dusdc: string
  }
}

// ────────────────────────────────────────────────────────────────────────
// Profile trades (GET /profile/trades)
// ────────────────────────────────────────────────────────────────────────

export interface ProfileTrade {
  id: string
  poolId: string
  side: 'bid' | 'ask'
  price: string
  quantity: string
  notional: string
  status: string
  txDigest: string | null
  orderId: string | null
  createdAt: number
}

export interface ProfileTradesResponse {
  trades: Array<ProfileTrade>
}

// ────────────────────────────────────────────────────────────────────────
// Instant deposit (POST /agent/deposit-instant)
// ────────────────────────────────────────────────────────────────────────

export interface DepositInstantResponse {
  digest: string
}

// ────────────────────────────────────────────────────────────────────────
// Pending deposit (auto-sweep flow)
// ────────────────────────────────────────────────────────────────────────

export interface PendingDepositCreatedResponse {
  id: string
  status: string
  amountMist: string
  expectedBy: string
  executorAddress: string
}

export interface PendingDepositRow {
  id: string
  status: 'awaiting' | 'swept' | 'failed' | 'expired' | string
  amountMist: string
  expectedBy: string
  sweptTxDigest: string | null
  createdAt: string
}

// ────────────────────────────────────────────────────────────────────────
// Notifications
// ────────────────────────────────────────────────────────────────────────

export interface NotificationItem {
  id: string
  kind: string
  title: string
  body: string
  payload: unknown
  readAt: string | null
  createdAt: string
}

// ────────────────────────────────────────────────────────────────────────
// Agent-signed trade
// ────────────────────────────────────────────────────────────────────────

export interface PlaceAsAgentResponse {
  digest: string
  clientOrderId: string
}
