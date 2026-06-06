import { ExternalLink, Receipt } from 'lucide-react'
import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusPulseDot } from '@/components/ui/StatusPulseDot'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// ── Types ─────────────────────────────────────────────────────────────────────

type EventKind =
  | 'TraderProfileCreated'
  | 'MemWalWrite'
  | 'AnchorRecorded'
  | 'TradePlaced'
  | 'GrantCreated'

interface ActivityEvent {
  kind: EventKind
  tx_digest: string
  timestamp_ms: number
  summary: string
  // / Optional deep-link to /receipt/<id> when the event has a backing
  // / Recommendation or Trade row. Populated by the backend's
  // / /activity/recent loaders.
  receipt_id?: string | null
  receipt_kind?: 'recommendation' | 'trade' | null
}

interface ActivityData {
  events: Array<ActivityEvent>
  total_indexed: number
}

interface ActivityResponse {
  success: boolean
  error: string | null
  data: ActivityData
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp_ms: number): string {
  const diff = Math.max(0, Date.now() - timestamp_ms)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Kind badge color per LIGHTHOUSE_PALETTE.md §4 token mapping.
// accent tokens for Walrus narrative moments, accent-warm for DeepBook,
// text-dim (neutral) for common/quieter events.
function kindColor(kind: EventKind): string {
  switch (kind) {
    case 'MemWalWrite':
    case 'AnchorRecorded':
      return 'text-lh-accent'
    case 'TradePlaced':
      return 'text-lh-accent-warm'
    case 'TraderProfileCreated':
    case 'GrantCreated':
      return 'text-lh-text-dim'
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KindBadge({ kind }: { kind: EventKind }) {
  return (
    <span
      className={`text-xs font-mono uppercase tracking-[0.12em] shrink-0 ${kindColor(kind)}`}
    >
      {kind}
    </span>
  )
}

function EventRow({ event }: { event: ActivityEvent }) {
  // Validated external link: hardcoded https scheme, tx_digest is path-only
  const suiscanUrl = `https://suiscan.xyz/testnet/tx/${event.tx_digest}`

  return (
    <div className="flex items-start gap-4 py-4 border-b border-lh-line last:border-b-0 transition-all duration-[var(--dur-fast)] ease-[var(--ease-sui)] hover:pl-3 hover:shadow-[inset_2px_0_0_rgb(251_191_36_/_0.3)]">
      {/* Kind badge — left */}
      <div className="w-[160px] shrink-0 pt-0.5">
        <KindBadge kind={event.kind} />
      </div>

      {/* Summary — center. React JSX escaping prevents XSS; no dangerouslySetInnerHTML */}
      <p className="flex-1 text-sm text-lh-text-dim leading-relaxed min-w-0">
        {event.summary}
      </p>

      {/* Right cluster: relative time + receipt + tx link */}
      <div className="flex items-center gap-2 shrink-0 pl-2">
        <span className="font-mono text-[11px] text-lh-text-mute tabular-nums whitespace-nowrap">
          {formatRelativeTime(event.timestamp_ms)}
        </span>
        {event.receipt_id && event.receipt_kind && (
          <Link
            to="/receipt/$id"
            params={{ id: event.receipt_id }}
            aria-label="Open verifiable Lighthouse receipt"
            title="Open verifiable receipt"
            className="text-lh-text-mute hover:text-lh-accent transition-colors duration-150"
          >
            <Receipt size={12} strokeWidth={1.5} aria-hidden="true" />
          </Link>
        )}
        <a
          href={suiscanUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View transaction on Suiscan: ${event.tx_digest.slice(0, 8)}…`}
          className="text-lh-text-mute hover:text-lh-accent transition-colors duration-150"
        >
          <ExternalLink size={12} strokeWidth={1.5} aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="space-y-0">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 py-4 border-b border-lh-line last:border-b-0"
        >
          <Skeleton className="h-3 w-[120px]" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ActivityStream() {
  const streamRef = useRef<HTMLDivElement>(null)

  const { data, isLoading, isError } = useQuery<ActivityResponse>({
    queryKey: ['activity-recent'],
    queryFn: async () => {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const res = await fetch(`${base}/activity/recent?limit=10`)
      if (!res.ok) throw new Error('Activity fetch failed')
      return res.json() as Promise<ActivityResponse>
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  const events: Array<ActivityEvent> = data?.data.events ?? []
  const totalIndexed: number | undefined = data?.data.total_indexed

  // One-shot entrance stagger on populated rows.
  // LIGHTHOUSE_MOTION_LANGUAGE.md §8: fadeInUp, --dur-standard 550ms, stagger-card 60ms.
  useGSAP(
    () => {
      if (!events.length || !streamRef.current) return

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const rows = streamRef.current!.querySelectorAll('.activity-row')
        if (!rows.length) return
        gsap.fromTo(
          rows,
          { autoAlpha: 0, y: 16 },
          {
            autoAlpha: 1,
            y: 0,
            stagger: 0.06,
            scrollTrigger: {
              trigger: streamRef.current,
              start: 'top 85%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        const rows =
          streamRef.current!.querySelectorAll<HTMLElement>('.activity-row')
        rows.forEach((r) => {
          r.style.opacity = '1'
          r.style.visibility = 'visible'
        })
      })
    },
    { scope: streamRef, dependencies: [events.length] },
  )

  return (
    <div ref={streamRef} className="w-full">
      {/* Live pulse header */}
      <div className="flex items-center justify-between mb-6">
        <StatusPulseDot label="LIVE" />
        {totalIndexed !== undefined && (
          <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
            {totalIndexed.toLocaleString('en-US')} events indexed
          </span>
        )}
      </div>

      {/* Loading state: 5 skeleton rows */}
      {isLoading && <SkeletonRows />}

      {/* Error state: generic message, no backend payload exposed */}
      {isError && (
        <p className="py-8 text-sm text-lh-text-dim text-center">
          Activity feed temporarily unavailable
        </p>
      )}

      {/* Settled state — empty or populated */}
      {!isLoading &&
        !isError &&
        (events.length === 0 ? (
          <p className="py-8 text-sm text-lh-text-dim text-center">
            No on-chain activity yet on this testnet deploy. Be the first.
          </p>
        ) : (
          <div>
            {events.map((event) => (
              <div
                key={event.tx_digest}
                className="activity-row"
                style={{ opacity: 0, visibility: 'hidden' }}
              >
                <EventRow event={event} />
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
