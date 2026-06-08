import { useEffect, useRef, useState } from 'react'
import { Anchor, ExternalLink, Loader2 } from 'lucide-react'

import { RecommendationCard } from './RecommendationCard'
import type { CoachRecommendResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { apiFetch } from '@/lib/api'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  // / Plain markdown-ish text (we render raw with whitespace preserved).
  text: string
  // / When set, render a recommendation card under the message body.
  recommendation?: CoachRecommendResponse
  // / Streaming state — only meaningful for assistant rows.
  streaming?: boolean
  timestamp: number
  // / Optional prior user prompt — stored for anchor-reply attribution so
  // / the receipt page shows "User asked X · Coach said Y".
  originalUserPrompt?: string | null
}

interface AnchorOk {
  status: 'ok'
  recommendationId: string
  txDigest: string
  walrusBlobId: string
}
interface AnchorErr {
  status: 'error'
  message: string
}
type AnchorState =
  | { status: 'idle' }
  | { status: 'pending' }
  | AnchorOk
  | AnchorErr

interface AnchorReplyResponse {
  recommendationId: string
  walrusBlobId: string
  walrusReadUrl: string
  auditAnchorTxDigest: string
  explorerUrl: string
  receiptUrl: string
}

interface Props {
  messages: Array<ChatMessage>
  poolKeyByObjectId?: Record<string, string>
}

/**
 * Auto-scrolling chat transcript. Streaming assistant rows render the
 * partial text plus a pulsing caret. Completed assistant rows that
 * carry a `recommendation` payload render the full RecommendationCard.
 */
export function ChatThread({ messages, poolKeyByObjectId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  // Map<message id, anchor state>. Kept inside ChatThread because the
  // anchor button is co-located with the message bubble and reset semantics
  // (clear when message is removed) are trivial here.
  const [anchorByMessageId, setAnchorByMessageId] = useState<
    Record<string, AnchorState>
  >({})

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleAnchor(m: ChatMessage) {
    if (!m.text || m.text.trim().length === 0) return
    setAnchorByMessageId((prev) => ({
      ...prev,
      [m.id]: { status: 'pending' },
    }))
    try {
      const res = await apiFetch<AnchorReplyResponse>('/coach/anchor-reply', {
        method: 'POST',
        body: {
          text: m.text,
          originalUserPrompt: m.originalUserPrompt ?? null,
        },
      })
      setAnchorByMessageId((prev) => ({
        ...prev,
        [m.id]: {
          status: 'ok',
          recommendationId: res.recommendationId,
          txDigest: res.auditAnchorTxDigest,
          walrusBlobId: res.walrusBlobId,
        },
      }))
    } catch (e) {
      setAnchorByMessageId((prev) => ({
        ...prev,
        [m.id]: {
          status: 'error',
          message: (e as Error).message ?? 'Anchor failed',
        },
      }))
    }
  }

  if (messages.length === 0) {
    return (
      <Card className="p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
          Coach session
        </p>
        <h3 className="text-2xl font-semibold tracking-[-0.02em] mb-3">
          Ask the coach anything
        </h3>
        <p className="text-sm text-lh-text-dim leading-relaxed max-w-md mx-auto">
          Inference runs on Atoma's decentralized network. Memory is recalled
          from your Walrus-backed MemWal namespaces. Every recommendation is
          replayable with the on-chain receipt.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {messages.map((m) => {
        const anchorState: AnchorState = anchorByMessageId[m.id] ?? {
          status: 'idle',
        }
        return (
          <Bubble
            key={m.id}
            role={m.role}
            streaming={m.streaming}
            timestamp={m.timestamp}
          >
            {m.text && (
              <p className="text-sm text-lh-text leading-relaxed whitespace-pre-wrap break-words">
                {m.text}
                {m.streaming && (
                  <span
                    className="ml-1 inline-block w-1.5 h-3.5 align-baseline bg-lh-accent animate-pulse"
                    aria-hidden="true"
                  />
                )}
              </p>
            )}
            {m.recommendation && (
              <div className="mt-4">
                <RecommendationCard
                  rec={m.recommendation}
                  poolKeyByObjectId={poolKeyByObjectId}
                />
              </div>
            )}
            {/* Anchor button: only on completed assistant text replies
                without a structured recommendation card (the recommendation
                card already carries its own receipt link). */}
            {m.role === 'assistant' &&
              !m.streaming &&
              !m.recommendation &&
              m.text.trim().length > 0 && (
                <AnchorRow
                  state={anchorState}
                  onClick={() => void handleAnchor(m)}
                />
              )}
          </Bubble>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}

function AnchorRow({
  state,
  onClick,
}: {
  state: AnchorState
  onClick: () => void
}) {
  if (state.status === 'ok') {
    return (
      <div className="mt-3 pt-3 border-t border-lh-line flex flex-wrap items-center gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 text-emerald-300 font-mono uppercase tracking-[0.14em]">
          <Anchor size={12} strokeWidth={1.8} />
          Anchored on Sui
        </span>
        <a
          href={`/receipt/${state.recommendationId}`}
          className="inline-flex items-center gap-1 text-lh-accent hover:underline font-mono"
        >
          View receipt
          <ExternalLink size={11} strokeWidth={1.6} />
        </a>
        <span
          className="font-mono text-[10px] text-lh-text-mute"
          title={state.txDigest}
        >
          tx {state.txDigest.slice(0, 8)}…
        </span>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="mt-3 pt-3 border-t border-lh-line flex items-center gap-3 text-xs">
        <span className="text-red-300">Anchor failed: {state.message}</span>
        <button
          type="button"
          onClick={onClick}
          className="text-lh-text-dim hover:text-lh-accent underline underline-offset-4"
        >
          Retry
        </button>
      </div>
    )
  }
  if (state.status === 'pending') {
    return (
      <div className="mt-3 pt-3 border-t border-lh-line flex items-center gap-2 text-xs text-lh-text-mute">
        <Loader2 size={12} strokeWidth={1.8} className="animate-spin" />
        <span>Uploading to Walrus + emitting AuditAnchor…</span>
      </div>
    )
  }
  return (
    <div className="mt-3 pt-3 border-t border-lh-line">
      <button
        type="button"
        onClick={onClick}
        className={cnm(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5',
          'text-[10px] font-mono uppercase tracking-[0.14em]',
          'border border-lh-line text-lh-text-dim',
          'hover:text-lh-accent hover:border-lh-accent/60 transition-colors',
        )}
        aria-label="Anchor this reply on Sui via Walrus"
      >
        <Anchor size={11} strokeWidth={1.8} />
        Anchor on Sui
      </button>
    </div>
  )
}

function Bubble({
  role,
  children,
  streaming,
  timestamp,
}: {
  role: ChatRole
  children: React.ReactNode
  streaming?: boolean
  timestamp: number
}) {
  const isUser = role === 'user'
  return (
    <div className={cnm('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cnm(
          'max-w-[min(640px,90%)]',
          isUser
            ? 'rounded-2xl rounded-tr-md bg-lh-accent/12 border border-lh-accent/30 px-4 py-3'
            : 'rounded-2xl rounded-tl-md bg-lh-bg-elev border border-lh-line px-4 py-3',
        )}
      >
        <div className="flex items-baseline gap-2 mb-1">
          <span
            className={cnm(
              'font-mono text-[10px] uppercase tracking-[0.18em]',
              isUser ? 'text-lh-accent' : 'text-lh-text-mute',
            )}
          >
            {isUser ? 'You' : 'Coach'}
            {streaming && !isUser ? ' · streaming' : ''}
          </span>
          <time className="font-mono text-[10px] text-lh-text-mute tabular-nums">
            {new Date(timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        {children}
      </div>
    </div>
  )
}
