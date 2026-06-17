/**
 * Guardian — synchronous validation between Atoma decisions and user signing.
 *
 * Per LIGHTHOUSE.md §12.5: every recommendation must pass Guardian BEFORE the
 * client previews it to the user. The Guardian's plain-language `summary` is
 * what the user sees in the trade preview UI.
 *
 * Checks (current):
 *   1. Pool ID is in the user's allowed_pools whitelist
 *   2. Notional <= max_notional_per_trade
 *   3. Notional <= remaining daily budget
 *   4. Estimated slippage < configured BPS threshold
 *   5. Market context not stale (>5s default)
 *
 * Anything that fails -> trade cannot proceed. Client renders the messages.
 */

import { z } from 'zod';

import {
  COACH_GUARDIAN_MARKET_FRESHNESS_MS,
  COACH_GUARDIAN_MAX_SLIPPAGE_BPS,
} from '../config/main-config.ts';

// === Schemas (Zod = primary defense against malformed LLM output) ===

export const decisionSchema = z.object({
  side: z.enum(['buy', 'sell']),
  /// Pool object ID (0x-prefixed).
  pool: z.string().regex(/^0x[a-fA-F0-9]+$/, 'invalid pool id'),
  /// FLOAT_SCALING'd price as string (for arbitrary precision over the wire).
  price: z.string().regex(/^\d+$/, 'price must be a non-negative integer string'),
  /// Base raw units as string.
  quantity: z.string().regex(/^\d+$/, 'quantity must be a non-negative integer string'),
  /// FLOAT_SCALING'd notional as string. Used by the Guardian to compare budgets.
  notional: z.string().regex(/^\d+$/, 'notional must be a non-negative integer string'),
  /// Optional Predict-side hedge spec.
  hedge: z.object({ strike: z.string(), is_up: z.boolean(), quantity: z.string() }).nullable(),
  /// 0..1 model self-confidence.
  confidence: z.number().min(0).max(1),
  /// Plain-language reasoning shown to the user.
  reasoning: z.string().min(1),
});
export type Decision = z.infer<typeof decisionSchema>;

export interface ExecutorAgentState {
  allowed_pools: string[];
  /// FLOAT_SCALING'd quote units.
  max_notional_per_trade: bigint;
  max_notional_per_day: bigint;
  spent_today: bigint;
}

export interface MarketContext {
  /// Top-of-book mid (FLOAT_SCALING'd), used for slippage estimation.
  mid_price: bigint;
  fetched_at_ms: number;
  /// Optional orderbook snapshot (price-quantity pairs, FLOAT_SCALING'd).
  /// When present, the Guardian walks the book to compute REAL slippage
  /// instead of the linear-from-mid heuristic. Pull from
  /// `deepbookQueries.getSuiDbusdcOrderbook`.
  bids?: { price: bigint; quantity: bigint }[];
  asks?: { price: bigint; quantity: bigint }[];
}

export interface GuardianCheck {
  name: string;
  pass: boolean;
  message: string;
}

export interface GuardianResult {
  overall_pass: boolean;
  checks: GuardianCheck[];
  summary: string;
}

export function guardianCheck(
  decision: Decision,
  agent: ExecutorAgentState,
  market: MarketContext,
): GuardianResult {
  const checks: GuardianCheck[] = [];
  const notional = BigInt(decision.notional);

  // 1. Pool allowlist
  const poolOk = agent.allowed_pools.includes(decision.pool);
  checks.push({
    name: 'pool_in_allowlist',
    pass: poolOk,
    message: poolOk
      ? 'Pool authorised'
      : `Pool ${shortenHex(decision.pool)} NOT in your agent's allowlist. Trade will revert.`,
  });

  // 2. Per-trade budget
  const tradeOk = notional <= agent.max_notional_per_trade;
  checks.push({
    name: 'within_per_trade_budget',
    pass: tradeOk,
    message: tradeOk
      ? `Within per-trade budget (${formatBig(notional)} / ${formatBig(agent.max_notional_per_trade)})`
      : `Notional ${formatBig(notional)} exceeds per-trade budget ${formatBig(agent.max_notional_per_trade)}.`,
  });

  // 3. Daily budget
  const remaining = agent.max_notional_per_day - agent.spent_today;
  const dailyOk = notional <= remaining;
  checks.push({
    name: 'within_daily_budget',
    pass: dailyOk,
    message: dailyOk
      ? `${formatBig(remaining)} units of daily budget remain`
      : `Only ${formatBig(remaining)} units left in daily budget; trade will revert.`,
  });

  // 4. Slippage estimate (simple linear from mid; refine with orderbook later)
  const slippageBps = estimateSlippageBps(decision, market);
  const slippageOk = slippageBps < COACH_GUARDIAN_MAX_SLIPPAGE_BPS;
  checks.push({
    name: 'slippage_under_threshold',
    pass: slippageOk,
    message: slippageOk
      ? `Estimated slippage ${(slippageBps / 100).toFixed(2)}%`
      : `Estimated slippage ${(slippageBps / 100).toFixed(2)}% exceeds ${(COACH_GUARDIAN_MAX_SLIPPAGE_BPS / 100).toFixed(2)}% limit. Consider splitting.`,
  });

  // 5. Market freshness
  const contextAgeMs = Date.now() - market.fetched_at_ms;
  const freshOk = contextAgeMs <= COACH_GUARDIAN_MARKET_FRESHNESS_MS;
  checks.push({
    name: 'fresh_market_context',
    pass: freshOk,
    message: freshOk
      ? 'Market data fresh'
      : `Market data is ${(contextAgeMs / 1000).toFixed(1)}s old; refresh before signing.`,
  });

  return {
    overall_pass: checks.every((c) => c.pass),
    checks,
    summary: checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.message}`).join('\n'),
  };
}

function estimateSlippageBps(decision: Decision, market: MarketContext): number {
  // Walking-the-book model when an orderbook snapshot is available. The book
  // is FLOAT_SCALING'd and `decision.quantity` is in base raw units, matching
  // what `getSuiDbusdcOrderbook` emits. Walk the side opposite to our trade:
  //   - BUY (decision.side == 'buy'):  consume asks from top up to our qty
  //   - SELL: consume bids from top up to our qty
  // Slippage = (vwap - touch) / touch in bps.
  const quantity = BigInt(decision.quantity);
  const side = decision.side;
  const book = side === 'buy' ? market.asks : market.bids;
  if (book && book.length > 0 && quantity > 0n) {
    let remaining = quantity;
    let costNumerator = 0n; // sum(price_i * filled_i) in FLOAT_SCALING'd units
    let filled = 0n;
    for (const level of book) {
      if (remaining === 0n) break;
      const take = level.quantity < remaining ? level.quantity : remaining;
      costNumerator += level.price * take;
      filled += take;
      remaining -= take;
    }
    if (filled === 0n) return 10_000;
    const vwap = costNumerator / filled;
    const touch = book[0]!.price;
    if (touch === 0n) return 10_000;
    const diff = vwap > touch ? vwap - touch : touch - vwap;
    // If we couldn't fill the entire order, treat the unfilled portion as
    // infinite-slippage signal — penalise heavily.
    if (remaining > 0n) {
      return 10_000;
    }
    return Number((diff * 10_000n) / touch);
  }
  // Fallback: simple absolute-deviation-from-mid model when no book is given.
  const price = BigInt(decision.price);
  const mid = market.mid_price;
  if (mid === 0n) return 10_000;
  const diff = price > mid ? price - mid : mid - price;
  return Number((diff * 10_000n) / mid);
}

function shortenHex(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function formatBig(n: bigint): string {
  return n.toString();
}

/**
 * Summarise a GuardianResult as a compact single-line string for logging.
 * Example: "PASS [✓✓✓✓✗] slippage 1.23%"
 */
export function guardianLogLine(result: GuardianResult): string {
  const icons = result.checks.map((c) => (c.pass ? '✓' : '✗')).join('')
  const firstFail = result.checks.find((c) => !c.pass)
  const detail = firstFail ? ` — ${firstFail.message}` : ''
  return `${result.overall_pass ? 'PASS' : 'FAIL'} [${icons}]${detail}`
}
