import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import type { ChatMessage } from '@/components/coach/ChatThread'
import type {
  AgentSnapshotResponse,
  CoachRecommendResponse,
  MemWalRecallEntry,
  MemWalRecallResponse,
  OrderBookSnapshot,
} from '@/lib/types'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Card } from '@/components/ui/Card'
import { OnboardingBanner } from '@/components/ui/OnboardingBanner'
import { Skeleton } from '@/components/ui/Skeleton'
import { ChatThread } from '@/components/coach/ChatThread'
import { RecallPanel } from '@/components/coach/RecallPanel'
import { ApiError, apiFetch, sseStream } from '@/lib/api'
import { requireRiskSetup } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { cnm } from '@/utils/style'

type Mode = 'chat' | 'recommend'

const POOL_KEY_BY_OBJECT_ID: Record<string, string> = {
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5':
    'SUI_DBUSDC',
  '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f':
    'DEEP_SUI',
}

export const Route = createFileRoute('/coach')({
  beforeLoad: requireRiskSetup,
  component: CoachPage,
  head: () => ({
    meta: [
      { title: 'Coach · Lighthouse' },
      {
        name: 'description',
        content:
          'Talk to your verifiable trading coach. Inference on Atoma, memory on Walrus + MemWal, every recommendation receipt-backed.',
      },
    ],
  }),
})

function CoachPage() {
  const { profile, isLoading: authLoading } = useAuth()
  const [mode, setMode] = useState<Mode>('recommend')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Array<ChatMessage>>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRecallMemories, setLastRecallMemories] = useState<
    Array<MemWalRecallEntry>
  >([])
  const streamAbortRef = useRef<AbortController | null>(null)

  const { data: agentData } = useQuery<AgentSnapshotResponse>({
    queryKey: ['agent', 'snapshot', profile?.suiAddress ?? ''],
    queryFn: () => apiFetch<AgentSnapshotResponse>('/agent/snapshot'),
    enabled: !!profile,
    staleTime: 60_000,
  })

  // Fetch live mid for the SUI_DBUSDC pool so /coach/recommend can ground
  // the Guardian decision on real depth. Falls back to a hardcoded value
  // if the orderbook is empty (testnet rarely has both sides).
  const { data: book } = useQuery<OrderBookSnapshot>({
    queryKey: ['coach', 'book', 'SUI_DBUSDC'],
    queryFn: () =>
      apiFetch<OrderBookSnapshot>('/deepbook/book/SUI_DBUSDC?levels=10'),
    refetchInterval: 5000,
    staleTime: 2500,
  })

  const midPriceScaled = useMemo(() => {
    // The coach orchestrator expects a FLOAT_SCALING'd (1e9) BigInt-string.
    // Backend's getSuiDbusdcMidPrice does the conversion, but here we hold
    // a human-decimal string. Multiply by 1e9 and truncate.
    if (!book?.mid) return null
    try {
      const n = Number(book.mid)
      if (!Number.isFinite(n) || n <= 0) return null
      return BigInt(Math.round(n * 1_000_000_000)).toString()
    } catch {
      return null
    }
  }, [book?.mid])

  const sendChat = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        id: cryptoRandomId(),
        role: 'user',
        text,
        timestamp: Date.now(),
      }
      setMessages((m) => [...m, userMsg])

      const assistantId = cryptoRandomId()
      setMessages((m) => [
        ...m,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          streaming: true,
          timestamp: Date.now(),
          // Preserve the original prompt so /coach/anchor-reply can attach it
          // to the receipt (renders "User asked X · Coach said Y").
          originalUserPrompt: text,
        },
      ])

      // Try to pull top-3 memories for context (silently ignore if MemWal not set up)
      let recalledCtx = ''
      try {
        const recalled = await apiFetch<MemWalRecallResponse>(
          '/memwal/recall?q=' + encodeURIComponent(text) + '&limit=3',
        )
        if (recalled.results.length > 0) {
          const lines = recalled.results
            .map(
              (r) => `- [${r.namespace ?? 'memory'}] ${r.text.slice(0, 200)}`,
            )
            .join('\n')
          recalledCtx = `\nRecalled memories:\n${lines}`
        }
      } catch {
        // MemWal not set up or recall failed — skip
      }

      // Build context prefix from live market data and agent budget.
      const mid = book?.mid
        ? `SUI/DBUSDC mid = $${Number(book.mid).toFixed(4)}`
        : null
      const snap = agentData?.snapshot
      const budget = snap
        ? `budget ${(Number(snap.spent_today) / 1e9).toFixed(2)} / ${(Number(snap.max_notional_per_day) / 1e9).toFixed(2)} DBUSDC spent today`
        : null
      const ctxParts = [mid, budget].filter(Boolean)
      const enrichedPrompt =
        ctxParts.length > 0 || recalledCtx
          ? `[Context: ${ctxParts.join('. ')}]${recalledCtx}\n${text}`
          : text

      const ctrl = new AbortController()
      streamAbortRef.current = ctrl
      setPending(true)
      try {
        const path = `/coach/chat?prompt=${encodeURIComponent(enrichedPrompt)}`
        for await (const frame of sseStream(path, { signal: ctrl.signal })) {
          if (frame.event === 'done') break
          if (frame.event === 'error') {
            const j = safeJson(frame.data) as { message?: string } | null
            throw new Error(j?.message ?? 'stream error')
          }
          const parsed = safeJson(frame.data) as { chunk?: string } | null
          if (parsed?.chunk) {
            setMessages((cur) =>
              cur.map((m) =>
                m.id === assistantId
                  ? { ...m, text: m.text + parsed.chunk }
                  : m,
              ),
            )
          }
        }
        setMessages((cur) =>
          cur.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          ),
        )
      } catch (e) {
        const msg = (e as Error).message || 'stream failed'
        setMessages((cur) =>
          cur.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  text: m.text + `\n\n[stream error: ${msg}]`,
                }
              : m,
          ),
        )
      } finally {
        streamAbortRef.current = null
        setPending(false)
      }
    },
    [book?.mid, agentData?.snapshot],
  )

  const sendRecommend = useCallback(
    async (text: string) => {
      if (!profile?.suiAddress) {
        setError('No bound Sui address — sign in first.')
        return
      }
      if (!midPriceScaled) {
        setError(
          'Could not fetch a live mid for SUI_DBUSDC. Try again in a moment.',
        )
        return
      }

      const userMsg: ChatMessage = {
        id: cryptoRandomId(),
        role: 'user',
        text,
        timestamp: Date.now(),
      }
      setMessages((m) => [...m, userMsg])
      setPending(true)
      setError(null)

      try {
        const rec = await apiFetch<CoachRecommendResponse>('/coach/recommend', {
          method: 'POST',
          body: {
            suiAddress: profile.suiAddress,
            userPrompt: text,
            market: {
              mid_price: midPriceScaled,
              fetched_at_ms: Date.now(),
            },
          },
        })
        setLastRecallMemories(
          rec.recalledMemories.map((m) => ({
            blobId: m.blobId,
            text: m.text,
            distance: m.distance,
            namespace: m.namespace,
          })),
        )
        setMessages((m) => [
          ...m,
          {
            id: cryptoRandomId(),
            role: 'assistant',
            text: rec.decision.reasoning ?? '',
            recommendation: rec,
            streaming: false,
            timestamp: Date.now(),
          },
        ])
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? `${e.message} (${e.code ?? e.status})`
            : (e as Error).message
        setError(msg || 'recommendation failed')
      } finally {
        setPending(false)
      }
    },
    [profile?.suiAddress, midPriceScaled],
  )

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || pending) return
    setInput('')
    if (mode === 'chat') void sendChat(text)
    else void sendRecommend(text)
  }

  function handleStop() {
    streamAbortRef.current?.abort()
  }

  if (authLoading || !profile) {
    return (
      <main className="bg-lh-bg text-lh-text min-h-screen">
        <AppNav />
        <section className="pt-28 pb-20">
          <Container>
            <Skeleton className="h-[480px]" />
          </Container>
        </section>
      </main>
    )
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <div className="mb-8">
            <EyebrowTag dot className="mb-3">
              Atoma · MemWal · Walrus
            </EyebrowTag>
            <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
              Coach
            </h1>
            <p className="text-lh-text-dim text-base max-w-2xl">
              Decentralized inference on Atoma, encrypted memory on
              Walrus-backed MemWal, on-chain receipts via Lighthouse audit
              anchors. Ask the coach about your positions or request a guarded
              recommendation.
            </p>
          </div>

          <OnboardingBanner className="mb-6" />

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
            <div className="space-y-4">
              <ChatThread
                messages={messages}
                poolKeyByObjectId={POOL_KEY_BY_OBJECT_ID}
              />

              {error && (
                <Card className="p-4 border border-red-500/40">
                  <p className="text-sm text-red-300">{error}</p>
                </Card>
              )}

              <Composer
                input={input}
                setInput={setInput}
                onSubmit={handleSubmit}
                onStop={handleStop}
                pending={pending}
                mode={mode}
                setMode={setMode}
                midReady={!!midPriceScaled || mode === 'chat'}
              />
            </div>

            <aside className="space-y-4">
              <RecallPanel
                memories={lastRecallMemories}
                loading={pending && mode === 'recommend'}
                title="Memories the coach used"
                subtitle="Cosine-distance matches pulled from your encrypted MemWal namespaces. The full set lives on Walrus and travels with your account across sessions and devices."
              />
              <CoachContextCard />
            </aside>
          </div>
        </Container>
      </section>
    </main>
  )
}

function Composer({
  input,
  setInput,
  onSubmit,
  onStop,
  pending,
  mode,
  setMode,
  midReady,
}: {
  input: string
  setInput: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  onStop: () => void
  pending: boolean
  mode: Mode
  setMode: (m: Mode) => void
  midReady: boolean
}) {
  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <ModeToggle mode={mode} setMode={setMode} />
          <span className="text-[11px] text-lh-text-mute font-mono uppercase tracking-[0.14em] ml-auto">
            {mode === 'recommend'
              ? 'POST /coach/recommend → Atoma + Guardian + Walrus'
              : 'GET /coach/chat (SSE) → Atoma stream'}
          </span>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit(e as unknown as React.FormEvent)
            }
          }}
          rows={3}
          placeholder={
            mode === 'recommend'
              ? 'Ask for a trade — e.g. "I want yield on USDC, low risk"'
              : 'Free-form question — e.g. "What did we decide about SUI last week?"'
          }
          className={cnm(
            'w-full rounded-xl border border-lh-line bg-lh-bg/60 px-4 py-3',
            'text-sm leading-relaxed resize-none',
            'focus:outline-none focus:border-lh-accent/60 focus:ring-1 focus:ring-lh-accent/40',
          )}
          disabled={pending && mode === 'recommend'}
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-lh-text-mute font-mono">
            {mode === 'recommend' && !midReady
              ? 'Waiting for live mid price…'
              : 'Enter to send · Shift+Enter for newline'}
          </p>
          <div className="flex gap-2">
            {pending && mode === 'chat' && (
              <button
                type="button"
                onClick={onStop}
                className="text-xs text-lh-text-dim hover:text-lh-text px-3 py-1.5 rounded-full border border-lh-line"
              >
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={
                pending || !input.trim() || (mode === 'recommend' && !midReady)
              }
              className={cnm(
                'inline-flex items-center gap-2 rounded-full',
                'bg-lh-accent text-lh-bg font-semibold',
                'text-sm px-5 py-2 leading-none',
                'hover:bg-lh-accent-warm transition-colors duration-150',
                'disabled:opacity-50 disabled:pointer-events-none',
              )}
            >
              {pending ? '…' : mode === 'recommend' ? 'Recommend' : 'Send'}
            </button>
          </div>
        </div>
      </form>
    </Card>
  )
}

function ModeToggle({
  mode,
  setMode,
}: {
  mode: Mode
  setMode: (m: Mode) => void
}) {
  const opts: Array<{ id: Mode; label: string }> = [
    { id: 'recommend', label: 'Recommend' },
    { id: 'chat', label: 'Chat' },
  ]
  return (
    <div
      role="tablist"
      className="inline-flex rounded-full border border-lh-line bg-lh-bg/40 p-0.5"
    >
      {opts.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === mode}
          type="button"
          onClick={() => setMode(o.id)}
          className={cnm(
            'rounded-full px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em]',
            o.id === mode
              ? 'bg-lh-accent/15 text-lh-accent'
              : 'text-lh-text-dim hover:text-lh-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CoachContextCard() {
  return (
    <Card className="p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
        How it works
      </p>
      <ol className="text-xs text-lh-text-dim space-y-2 leading-relaxed">
        <li>
          <span className="font-mono text-lh-text">1.</span> Coach calls{' '}
          <span className="font-mono">recall</span> across your 7 MemWal
          namespaces.
        </li>
        <li>
          <span className="font-mono text-lh-text">2.</span> Atoma generates a
          decision (constrained tool schema).
        </li>
        <li>
          <span className="font-mono text-lh-text">3.</span> Guardian dry-runs
          against your ExecutorAgent's budget.
        </li>
        <li>
          <span className="font-mono text-lh-text">4.</span> Decision + memory
          archived to Walrus, anchored on-chain.
        </li>
        <li>
          <span className="font-mono text-lh-text">5.</span> Receipt is public
          and replayable.
        </li>
      </ol>
    </Card>
  )
}

function cryptoRandomId(): string {
  try {
    // Avoid `crypto.randomUUID` on older browsers — use a coarse fallback.
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // ignore
  }
  return `id_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
