/**
 * CoachOrchestrator — the heart of the recommendation flow.
 *
 * Pipeline (LIGHTHOUSE.md §4.4 + §12):
 *   1. Recall relevant memories from MemWal across all 7 namespaces
 *   2. Build the Atoma prompt (system + user) including recalled context
 *   3. Call Atoma `chat.create` (standard endpoint v1)
 *   4. Zod-parse the JSON output
 *   5. Run Guardian validation against the user's ExecutorAgent state
 *   6. Return decision + guardian summary to the caller (route writes blob etc)
 *
 * The actual PTB compose + sign + Walrus write happens at the route layer
 * after the user confirms the preview.
 */

import { z } from 'zod';
import { chatCreate, chatCreateConfidential, type ChatMessage } from '../lib/atoma.ts';
import { recallAll, type MemWalCreateArgs } from '../lib/memwal.ts';
import {
  decisionSchema,
  guardianCheck,
  type Decision,
  type ExecutorAgentState,
  type GuardianResult,
  type MarketContext,
} from './GuardianLayer.ts';

const COACH_SYSTEM_PROMPT = `You are Lighthouse, a verifiable AI trading coach.
You will be given:
  - The user's risk profile, recent trades, and stated goals (semantically recalled)
  - Their ExecutorAgent budget and pool whitelist
  - Current orderbook context (top-of-book)
  - The user's request

Respond with a SINGLE JSON object matching the Decision schema. Field types are STRICT:
  - side: "buy" | "sell"
  - pool: lowercased 0x-prefixed hex string (pool object ID from the user's whitelist)
  - price: integer string, FLOAT_SCALING'd (multiply quote-per-base by 1e9 then floor)
  - quantity: integer string, base raw units
  - notional: integer string, (price * quantity) / 1e9
  - hedge: null OR { strike: string, is_up: boolean, quantity: string }
  - confidence: number in [0, 1]
  - reasoning: short plain-language explanation (<= 280 chars)

NEVER recommend a pool NOT in the user's whitelist. NEVER recommend more than
max_notional_per_trade. Prefer smaller sizes when uncertain. Output JSON only.`;

export interface CoachRequest {
  userPrompt: string;
  /// MemWal credentials for the user's account.
  memwal: MemWalCreateArgs;
  /// Snapshot of the user's ExecutorAgent state.
  agent: ExecutorAgentState;
  /// Top-of-book market context.
  market: MarketContext;
  /// Limit how many memories to recall per namespace (default 3).
  recallLimit?: number;
}

export interface CoachResponse {
  decision: Decision;
  guardian: GuardianResult;
  atomaRequestHash: string;
  atomaModel: string;
  /// Which Atoma endpoint produced this result ('standard' | 'confidential').
  atomaEndpoint: 'standard' | 'confidential';
  /// TEE attestation hash (confidential endpoint only).
  atomaResponseHash: string | null;
  /// TEE node signature (confidential endpoint only).
  atomaNodeSignature: string | null;
  /// Raw text returned by the model (kept for audit).
  rawText: string;
  /// Memories that were folded into the prompt.
  recalledMemories: { blobId: string; text: string; distance: number }[];
}

/**
 * Run a one-shot coach recommendation. Caller persists `decision` +
 * `guardian.summary` to the Recommendation table.
 */
export async function recommend(req: CoachRequest): Promise<CoachResponse> {
  // 1. Recall.
  const recalled = await recallAll(req.memwal, req.userPrompt, req.recallLimit ?? 3);

  // 2. Build prompt.
  const messages: ChatMessage[] = [
    { role: 'system', content: COACH_SYSTEM_PROMPT },
    {
      role: 'system',
      content:
        `User agent state:\n` +
        `  allowed_pools: ${JSON.stringify(req.agent.allowed_pools)}\n` +
        `  max_per_trade: ${req.agent.max_notional_per_trade.toString()}\n` +
        `  max_per_day:   ${req.agent.max_notional_per_day.toString()}\n` +
        `  spent_today:   ${req.agent.spent_today.toString()}\n\n` +
        `Market context (FLOAT_SCALING'd):\n` +
        `  mid_price:    ${req.market.mid_price.toString()}\n` +
        `  fetched_at_ms: ${req.market.fetched_at_ms}\n\n` +
        `Recalled memories (top-${recalled.length} by similarity):\n` +
        recalled
          .slice(0, 12)
          .map((m, i) => `  [${i}] (dist=${m.distance.toFixed(3)}) ${m.text}`)
          .join('\n'),
    },
    { role: 'user', content: req.userPrompt },
  ];

  // 3. Call Atoma. Confidential endpoint when flag is set; else standard.
  // Confidential gives us TEE-attested `responseHash` + `nodeSignature` which
  // land in the on-chain audit blob (the killer Atoma narrative).
  const useConfidential = process.env.COACH_CONFIDENTIAL === '1';
  const atoma = await (useConfidential ? chatCreateConfidential : chatCreate)(messages, {
    temperature: 0.3,
    maxCompletionTokens: 2000,
    responseFormatJson: true,
  });

  // 4. Parse.
  let parsed: Decision;
  try {
    const json = extractJsonObject(atoma.text);
    parsed = decisionSchema.parse(json);
  } catch (e) {
    throw new CoachOutputError(`Atoma output did not match decision schema`, atoma.text, e);
  }

  // 5. Guardian validate.
  const guardian = guardianCheck(parsed, req.agent, req.market);

  return {
    decision: parsed,
    guardian,
    atomaRequestHash: atoma.requestHash,
    atomaModel: atoma.model,
    atomaEndpoint: atoma.endpoint,
    atomaResponseHash: atoma.responseHash,
    atomaNodeSignature: atoma.nodeSignature,
    rawText: atoma.text,
    recalledMemories: recalled.slice(0, 12),
  };
}

/**
 * Models sometimes wrap JSON in code fences. Extract the first complete object.
 */
function extractJsonObject(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output');
  // naive but adequate: take the largest balanced object starting at start
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  throw new Error('unbalanced JSON');
}

export class CoachOutputError extends Error {
  rawText: string;
  cause?: unknown;
  constructor(message: string, rawText: string, cause?: unknown) {
    super(message);
    this.name = 'CoachOutputError';
    this.rawText = rawText;
    this.cause = cause;
  }
}

/// Used elsewhere to surface validation errors uniformly.
export { z };
