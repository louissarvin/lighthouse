import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Receipt } from 'lucide-react'

import type { ActivityData, ActivityEvent } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { config } from '@/config'

function relTime(timestampMs: number): string {
  const diff = Math.max(0, Date.now() - timestampMs)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function RecentTrades({ filterAddress }: { filterAddress?: string }) {
  const { data, isLoading } = useQuery<ActivityData>({
    queryKey: ['trade', 'recent-trades', filterAddress ?? 'all'],
    queryFn: () => apiFetch<ActivityData>('/activity/recent?limit=30'),
    refetchInterval: 10_000,
    staleTime: 8_000,
  })

  const all: Array<ActivityEvent> = data?.events ?? []
  let trades = all.filter((e) => e.kind === 'TradePlaced')
  if (filterAddress) {
    const needle = filterAddress.toLowerCase().slice(2, 12)
    trades = trades.filter((e) => e.summary.toLowerCase().includes(needle))
  }
  trades = trades.slice(0, 5)

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold">Your recent trades</h3>
        <span className="font-mono text-[10px] text-lh-text-mute uppercase tracking-[0.12em]">
          Live
        </span>
      </div>
      {isLoading && <Skeleton className="h-12 w-full" />}
      {!isLoading && trades.length === 0 && (
        <p className="text-xs text-lh-text-mute py-2">
          No trades on this account yet.
        </p>
      )}
      <ul className="space-y-2">
        {trades.map((t) => (
          <li
            key={t.tx_digest}
            className="flex items-center justify-between gap-3"
          >
            <p className="flex-1 text-xs text-lh-text-dim truncate">
              {t.summary}
            </p>
            <span className="font-mono text-[11px] text-lh-text-mute tabular-nums">
              {relTime(t.timestamp_ms)}
            </span>
            {t.receipt_id && t.receipt_kind === 'trade' && (
              <Link
                to="/receipt/$id"
                params={{ id: t.receipt_id }}
                aria-label="Open Lighthouse trade receipt"
                title="Open verifiable receipt"
                className="text-lh-text-mute hover:text-lh-accent"
              >
                <Receipt size={11} strokeWidth={1.5} aria-hidden="true" />
              </Link>
            )}
            <a
              href={`${config.links.explorerBase}/tx/${t.tx_digest}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lh-text-mute hover:text-lh-accent"
            >
              <ExternalLink size={11} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}
