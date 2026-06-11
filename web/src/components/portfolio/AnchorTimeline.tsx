import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Receipt } from 'lucide-react'

import type { ActivityData, ActivityEvent, EventKind } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { config } from '@/config'

function relTime(timestampMs: number): string {
  const diff = Math.max(0, Date.now() - timestampMs)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function kindColor(kind: EventKind): string {
  switch (kind) {
    case 'MemWalWrite':
    case 'AnchorRecorded':
      return 'text-lh-accent'
    case 'TradePlaced':
      return 'text-lh-accent-warm'
    default:
      return 'text-lh-text-dim'
  }
}

interface Props {
  // / Optional sui_address filter (frontend filter; backend returns global feed).
  filterAddress?: string
}

export function AnchorTimeline({ filterAddress }: Props) {
  const { data, isLoading, isError } = useQuery<{ data: ActivityData }>({
    queryKey: ['portfolio', 'anchors', filterAddress ?? 'all'],
    queryFn: async () => {
      // /activity/recent returns { success, error, data: ActivityData }.
      // apiFetch unwraps to ActivityData directly.
      const d = await apiFetch<ActivityData>('/activity/recent?limit=20')
      return { data: d }
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  const events: Array<ActivityEvent> = data?.data.events ?? []
  // Best-effort frontend filter: address may appear inside the summary.
  const filtered = filterAddress
    ? events.filter((e) =>
        e.summary
          .toLowerCase()
          .includes(filterAddress.toLowerCase().slice(2, 12)),
      )
    : events

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold">Audit anchors</h3>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          Recent on-chain receipts
        </span>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          Activity feed temporarily unavailable
        </p>
      )}

      {!isLoading && !isError && filtered.length === 0 && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          No anchors yet for this account. Place a trade or write a memory to
          mint your first receipt.
        </p>
      )}

      <div>
        {filtered.map((event) => (
          <div
            key={`${event.kind}:${event.tx_digest}`}
            className="flex items-start gap-4 py-3 border-b border-lh-line last:border-b-0"
          >
            <div className="w-[150px] shrink-0">
              <span
                className={cnm(
                  'text-[11px] font-mono uppercase tracking-[0.12em]',
                  kindColor(event.kind),
                )}
              >
                {event.kind}
              </span>
            </div>
            <p className="flex-1 text-sm text-lh-text-dim leading-relaxed min-w-0">
              {event.summary}
            </p>
            <div className="flex items-center gap-2 shrink-0 pl-2">
              <span className="font-mono text-[11px] text-lh-text-mute tabular-nums whitespace-nowrap">
                {relTime(event.timestamp_ms)}
              </span>
              {event.receipt_id && event.receipt_kind && (
                <Link
                  to="/receipt/$id"
                  params={{ id: event.receipt_id }}
                  aria-label="Open Lighthouse receipt"
                  title="Open verifiable receipt"
                  className="text-lh-text-mute hover:text-lh-accent transition-colors"
                >
                  <Receipt size={12} strokeWidth={1.5} aria-hidden="true" />
                </Link>
              )}
              {event.tx_digest && !event.tx_digest.startsWith('memwal:') && (
                <a
                  href={`${config.links.explorerBase}/tx/${event.tx_digest}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View on explorer"
                  className="text-lh-text-mute hover:text-lh-accent transition-colors"
                >
                  <ExternalLink
                    size={12}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
