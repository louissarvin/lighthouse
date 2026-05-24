/**
 * Risk-profile onboarding questions (UC1 — LIGHTHOUSE.md §3.2).
 *
 * Single source of truth shared by:
 *   - Telegram bot `/setup` state machine (src/lib/telegramBot.ts)
 *   - Web onboarding wizard (GET /onboarding/risk-questions)
 *
 * Question prompts are Markdown-formatted (Telegram uses Markdown; web should
 * render them through a Markdown component or strip the markers).
 *
 * The `kind` discriminator lets clients group answers by trait when persisting
 * to MemWal namespaces.
 */

export type RiskQuestionKind =
  | 'goal'
  | 'horizon'
  | 'risk_tolerance'
  | 'experience'
  | 'budget';

export interface RiskQuestion {
  id: string;
  prompt: string;
  kind: RiskQuestionKind;
}

/**
 * Ordered list. Index here MUST match the index used by the Telegram bot's
 * `SetupSession.step` counter, so existing sessions resume correctly after a
 * deploy.
 */
export const RISK_QUESTIONS: readonly RiskQuestion[] = [
  {
    id: 'q1_goal',
    kind: 'goal',
    prompt:
      '1️⃣ *What is your primary trading goal?*\n\n' +
      'Examples: "grow my portfolio 20% this year", "generate monthly income from volatility", ' +
      '"preserve capital with small speculative positions".',
  },
  {
    id: 'q2_horizon',
    kind: 'horizon',
    prompt:
      '2️⃣ *What is your time horizon for trades?*\n\n' +
      'Examples: "intraday scalp (minutes to hours)", "swing trade (days to weeks)", ' +
      '"hold for months".',
  },
  {
    id: 'q3_drawdown',
    kind: 'risk_tolerance',
    prompt:
      '3️⃣ *What is your maximum acceptable drawdown?*\n\n' +
      'Examples: "5% of portfolio", "I can tolerate losing 50% on any single bet", ' +
      '"stop-loss at 2%".',
  },
  {
    id: 'q4_markets',
    kind: 'experience',
    prompt:
      '4️⃣ *Which markets interest you most?*\n\n' +
      'Examples: "BTC/USD price direction", "SUI/DBUSDC spot", "any high-volatility pair", ' +
      '"stablecoin yield".',
  },
  {
    id: 'q5_leverage',
    kind: 'risk_tolerance',
    prompt:
      '5️⃣ *How do you feel about leverage and binary outcomes?*\n\n' +
      'Examples: "comfortable with all-or-nothing binary bets", "prefer limit orders with ' +
      'defined risk", "avoid leverage entirely".',
  },
] as const;

/// Backwards-compatible string-only array for the existing Telegram bot state
/// machine. New callers should use `RISK_QUESTIONS` directly.
export const SETUP_QUESTION_PROMPTS: readonly string[] = RISK_QUESTIONS.map(
  (q) => q.prompt,
);
