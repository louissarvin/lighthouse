/**
 * Atoma SDK (mainnet alpha — no testnet endpoint).
 *
 * Source: atoma-sdk@0.2.1 README + memory/atoma_reverify_2026_06.md.
 * Env: ATOMASDK_BEARER_AUTH.
 *
 * v1 uses the STANDARD chat endpoint. Confidential (TEE-attested) endpoint is
 * v2 stretch per LIGHTHOUSE.md §12.3.
 *
 * SECURITY:
 *   - `bearerAuth` is server-only; never bundle to frontend.
 *   - Always Zod-parse the response; `responseFormat: { type: 'json_object' }`
 *     is a best-effort hint, NOT a contract.
 *   - Verify model availability at boot via `models.modelsList()`.
 */

import { AtomaSDK } from 'atoma-sdk';
import { createHash } from 'node:crypto';

import {
  ATOMA_DEFAULT_MODEL,
  ATOMASDK_BEARER_AUTH,
  GROQ_API_KEY,
  GROQ_DEFAULT_MODEL,
} from '../config/main-config.ts';

let _atoma: AtomaSDK | null = null;

export function getAtoma(): AtomaSDK {
  if (!_atoma) {
    if (!ATOMASDK_BEARER_AUTH) {
      throw new Error('[atoma] ATOMASDK_BEARER_AUTH is not set');
    }
    _atoma = new AtomaSDK({ bearerAuth: ATOMASDK_BEARER_AUTH });
  }
  return _atoma;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxCompletionTokens?: number;
  responseFormatJson?: boolean;
}

export interface AtomaResponse {
  /// Raw text from the model.
  text: string;
  /// Model that produced it (echo).
  model: string;
  /// Request-side SHA-256 hash (for audit).
  requestHash: string;
  /// Endpoint hit ('standard' or 'confidential').
  endpoint: 'standard' | 'confidential';
  /// Confidential endpoint only: TEE-attested response hash (base64). Null on standard.
  responseHash: string | null;
  /// Confidential endpoint only: ed25519 signature from TEE node (base64). Null on standard.
  nodeSignature: string | null;
}

/**
 * Groq OpenAI-compatible chat completion.
 *
 * Used as the preferred provider when `GROQ_API_KEY` is set. Free tier
 * gives 30 RPM + 100K tokens/day on llama-3.3-70b-versatile, with ~320
 * tokens/sec inference. No SDK dependency — direct fetch.
 *
 * Doc: https://console.groq.com/docs/openai
 */
async function groqChatCreate(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<AtomaResponse> {
  const requestHash = hashRequest(messages);
  const model = opts.model && !opts.model.includes('meta-llama')
    ? opts.model
    : GROQ_DEFAULT_MODEL;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxCompletionTokens ?? 2000,
      ...(opts.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`[groq] ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };
  const text = body.choices?.[0]?.message?.content ?? '';
  return {
    text,
    model: body.model ?? model,
    requestHash,
    endpoint: 'standard',
    responseHash: null,
    nodeSignature: null,
  };
}

/**
 * One-shot chat completion. Used by CoachOrchestrator + Telegram bot.
 *
 * Provider precedence:
 *   1. Groq (if GROQ_API_KEY set) — free, fast, OpenAI-compatible
 *   2. Atoma (if ATOMASDK_BEARER_AUTH set) — Sui-native decentralized inference
 *   3. Throw — no provider configured
 *
 * The Atoma path remains the production aspiration; Groq is the demo-grade
 * fallback that gets us shipping while the Atoma key is being provisioned.
 */
export async function chatCreate(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<AtomaResponse> {
  // Prefer Groq if configured.
  if (GROQ_API_KEY) {
    return groqChatCreate(messages, opts);
  }

  if (!ATOMASDK_BEARER_AUTH) {
    throw new Error(
      '[chat] no LLM provider configured. Set GROQ_API_KEY (recommended for demo) ' +
        'or ATOMASDK_BEARER_AUTH (production) in .env.',
    );
  }

  const atoma = getAtoma();
  const requestHash = hashRequest(messages);

  const response = await atoma.chat.create({
    model: opts.model ?? ATOMA_DEFAULT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    maxCompletionTokens: opts.maxCompletionTokens ?? 2000,
    ...(opts.responseFormatJson ? { responseFormat: { type: 'json_object' as const } } : {}),
  });

  // `message.content` is `string | MessageContentPart[]`. For our use we ask
  // for text-only output; coerce to string for the parts shape too.
  const rawContent = response.choices?.[0]?.message?.content;
  const text =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent
            .map((p) => (typeof (p as { text?: string }).text === 'string' ? (p as { text: string }).text : ''))
            .join('')
        : '';
  return {
    text,
    model: response.model ?? (opts.model ?? ATOMA_DEFAULT_MODEL),
    requestHash,
    endpoint: 'standard',
    responseHash: null,
    nodeSignature: null,
  };
}

/**
 * Confidential (TEE-attested) chat completion.
 *
 * Per LIGHTHOUSE.md §12.3 + memory/atoma_reverify_2026_06.md: the SDK's
 * `confidentialChat.create` accepts the standard chat request shape on
 * `atoma-sdk@0.2.1`; the SDK handles X25519 KEM + AES-256-GCM internally if
 * the version supports it, otherwise the manual encryption path is required.
 *
 * Captures `responseHash` and `signature` from the TEE node when present.
 * These become part of the on-chain audit blob — the killer Atoma narrative.
 *
 * Falls back to standard if the SDK does not expose `confidentialChat` or
 * the call throws, so feature flagging is safe.
 */
export async function chatCreateConfidential(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<AtomaResponse> {
  const atoma = getAtoma();
  const requestHash = hashRequest(messages);
  // SDK shape varies across versions; defensive narrow.
  const sdk = atoma as unknown as {
    confidentialChat?: {
      create: (req: Record<string, unknown>) => Promise<unknown>;
    };
  };
  if (!sdk.confidentialChat?.create) {
    // No confidential endpoint exposed — fall back to standard.
    return chatCreate(messages, opts);
  }
  try {
    const response = (await sdk.confidentialChat.create({
      model: opts.model ?? ATOMA_DEFAULT_MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
      maxCompletionTokens: opts.maxCompletionTokens ?? 2000,
      ...(opts.responseFormatJson ? { responseFormat: { type: 'json_object' as const } } : {}),
    })) as {
      choices?: { message?: { content?: string | unknown[] } }[];
      model?: string;
      responseHash?: string;
      response_hash?: string;
      signature?: string;
      usage?: unknown;
    };
    const rawContent = response.choices?.[0]?.message?.content;
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((p) => (typeof (p as { text?: string }).text === 'string' ? (p as { text: string }).text : ''))
              .join('')
          : '';
    return {
      text,
      model: response.model ?? (opts.model ?? ATOMA_DEFAULT_MODEL),
      requestHash,
      endpoint: 'confidential',
      responseHash: response.responseHash ?? response.response_hash ?? null,
      nodeSignature: response.signature ?? null,
    };
  } catch (e) {
    console.warn('[atoma] confidentialChat failed, falling back to standard:', (e as Error).message);
    return chatCreate(messages, opts);
  }
}

/**
 * Streaming chat completion. Yields each token chunk as it arrives.
 *
 * Same provider precedence as `chatCreate`: Groq → Atoma → throw. Critical
 * for the demo because the public /coach/chat SSE endpoint silently errored
 * with "ATOMASDK_BEARER_AUTH not set" while Groq was already configured.
 */
export async function* chatCreateStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, void, void> {
  if (GROQ_API_KEY) {
    yield* groqChatCreateStream(messages, opts);
    return;
  }

  if (!ATOMASDK_BEARER_AUTH) {
    throw new Error(
      '[chat-stream] no LLM provider configured. Set GROQ_API_KEY (recommended for demo) ' +
        'or ATOMASDK_BEARER_AUTH (production) in .env.',
    );
  }

  const atoma = getAtoma();
  const stream = await atoma.chat.createStream({
    model: opts.model ?? ATOMA_DEFAULT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    maxCompletionTokens: opts.maxCompletionTokens ?? 2000,
    ...(opts.responseFormatJson ? { responseFormat: { type: 'json_object' as const } } : {}),
  });

  for await (const event of stream) {
    // SDK stream shape varies across atoma-sdk versions; defensive narrow.
    const ev = event as unknown as {
      choices?: { delta?: { content?: string | null } }[];
    };
    const chunk = ev.choices?.[0]?.delta?.content ?? '';
    if (chunk) yield chunk;
  }
}

/**
 * Groq streaming via the OpenAI-compatible SSE endpoint. Reads chunked
 * `data: { ... }` frames, yields the delta text from each. Terminates on
 * `data: [DONE]` per the OpenAI streaming spec.
 *
 * Doc: https://console.groq.com/docs/api-reference#chat-create
 */
async function* groqChatCreateStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, void, void> {
  const model =
    opts.model && !opts.model.includes('meta-llama')
      ? opts.model
      : GROQ_DEFAULT_MODEL;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxCompletionTokens ?? 2000,
      stream: true,
      ...(opts.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(
      `[groq-stream] ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by \n\n. Each frame may contain `data: { ... }` lines.
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep).trim();
        buf = buf.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          if (!payload) continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: string | null } }[];
            };
            const chunk = json.choices?.[0]?.delta?.content ?? '';
            if (chunk) yield chunk;
          } catch {
            // Malformed JSON frame — skip silently per OpenAI spec.
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released — ignore
    }
  }
}

/**
 * Models list for boot-time verification (e.g. confirm Llama-3.3-70B is up).
 */
export async function listModels(): Promise<string[]> {
  const atoma = getAtoma();
  // modelsList shape varies across SDK versions; defensive narrow.
  const sdk = atoma as unknown as { models: { modelsList(): Promise<unknown> } };
  const res = await sdk.models.modelsList();
  const arr = Array.isArray(res)
    ? (res as { id?: string }[])
    : (((res as { data?: { id?: string }[] } | null)?.data) ?? []);
  return arr.map((m) => m.id ?? '').filter(Boolean);
}

function hashRequest(messages: ChatMessage[]): string {
  const h = createHash('sha256');
  for (const m of messages) {
    h.update(m.role);
    h.update('\x00');
    h.update(m.content);
    h.update('\x00');
  }
  return h.digest('hex');
}

/**
 * Count tokens in a message array (rough estimate: ~4 chars per token).
 * Use before API calls to guard against context window overflows.
 * This is NOT tiktoken — it's a fast heuristic for budget checks.
 */
export function estimateTokenCount(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.role.length + m.content.length + 5, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Truncate messages to stay within a token budget.
 * Keeps the system message (first) + most recent messages.
 */
export function truncateMessages(
  messages: ChatMessage[],
  maxTokens = 6_000,
): ChatMessage[] {
  if (estimateTokenCount(messages) <= maxTokens) return messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages.slice(system.length)
  const out: ChatMessage[] = [];
  let budget = maxTokens - estimateTokenCount(system);
  for (let i = rest.length - 1; i >= 0 && budget > 0; i--) {
    const tokens = Math.ceil((rest[i]!.role.length + rest[i]!.content.length + 5) / 4);
    if (tokens > budget) break;
    out.unshift(rest[i]!);
    budget -= tokens;
  }
  return [...system, ...out];
}
