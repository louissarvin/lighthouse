import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import type { ProfileTrade, ProfileTradesResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { config } from '@/config'

const POOL_LABELS: Record<string, string> = {
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5':
    'SUI/DBUSDC',
  '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f':
    'DEEP/SUI',
  '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a':
    'WAL/SUI',
}

function poolLabel(poolId: string): string {
  return POOL_LABELS[poolId] ?? `${poolId.slice(0, 6)}…`
}

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

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls = cnm(
    'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
    s === 'filled' && 'bg-emerald-500/15 text-emerald-400',
    s === 'placed' && 'bg-lh-accent/15 text-lh-accent',
    s === 'canceled' && 'bg-lh-bg/30 text-lh-text-mute border border-lh-line',
    s === 'failed' && 'bg-red-500/15 text-red-400',
    !['filled', 'placed', 'canceled', 'failed'].includes(s) &&
      'bg-lh-bg/30 text-lh-text-mute',
  )
  return <span className={cls}>{status}</span>
}

function TradeRow({ trade }: { trade: ProfileTrade }) {
  const price = (Number(BigInt(trade.price)) / 1e9).toFixed(4)
  const qty = (Number(BigInt(trade.quantity)) / 1e9).toFixed(4)
  const isBuy = trade.side === 'bid'

  return (
    <tr
      className={cnm(
        'border-t border-lh-line',
        'hover:bg-lh-bg/40 transition-colors',
      )}
    >
      <td className="py-3 pr-4 align-top font-mono text-[12px] text-lh-text-mute tabular-nums whitespace-nowrap">
        {relTime(trade.createdAt)}
      </td>
      <td className="py-3 pr-4 align-top font-mono text-xs text-lh-text-dim whitespace-nowrap">
        {poolLabel(trade.poolId)}
      </td>
      <td className="py-3 pr-4 align-top">
        <span
          className={cnm(
            'font-mono text-xs font-semibold',
            isBuy ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {isBuy ? 'BUY' : 'SELL'}
        </span>
      </td>
      <td className="py-3 pr-4 align-top font-mono text-xs tabular-nums text-lh-text-dim whitespace-nowrap">
        {price}
      </td>
      <td className="py-3 pr-4 align-top font-mono text-xs tabular-nums text-lh-text-dim whitespace-nowrap">
        {qty}
      </td>
      <td className="py-3 pr-4 align-top">
        <StatusPill status={trade.status} />
      </td>
      <td className="py-3 align-top text-right">
        <div className="flex items-center justify-end gap-2">
          {trade.txDigest && (
            <a
              href={`${config.links.explorerBase}/tx/${trade.txDigest}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-lh-text-mute hover:text-lh-accent transition-colors"
              aria-label="View transaction on Suiscan"
            >
              <span className="font-mono text-[11px]">
                {trade.txDigest.slice(0, 8)}…
              </span>
              <ExternalLink size={11} strokeWidth={1.5} aria-hidden="true" />
            </a>
          )}
          {trade.id && (
            <a
              href={`/receipt/${trade.id}`}
              className="font-mono text-[11px] text-lh-text-mute hover:text-lh-accent transition-colors"
            >
              receipt
            </a>
          )}
        </div>
      </td>
    </tr>
  )
}

export function TradesTable({ filterAddress }: { filterAddress?: string }) {
  const { data, isLoading, isError } = useQuery<ProfileTradesResponse>({
    queryKey: ['profile', 'trades'],
    queryFn: () => apiFetch<ProfileTradesResponse>('/profile/trades?limit=20'),
    enabled: !!filterAddress,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const trades = data?.trades ?? []

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold">Recent trades</h3>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          DeepBook orders
        </span>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          Trades feed temporarily unavailable
        </p>
      )}

      {!isLoading && !isError && trades.length === 0 && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          No trades yet. Place a limit order from the{' '}
          <a href="/trade" className="text-lh-accent hover:text-lh-accent-warm">
            Trade
          </a>{' '}
          page.
        </p>
      )}

      {trades.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono uppercase tracking-[0.12em] text-lh-text-mute">
                <th className="pb-3 pr-4">When</th>
                <th className="pb-3 pr-4">Pool</th>
                <th className="pb-3 pr-4">Side</th>
                <th className="pb-3 pr-4">Price</th>
                <th className="pb-3 pr-4">Qty</th>
                <th className="pb-3 pr-4">Status</th>
                <th className="pb-3 text-right">Links</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <TradeRow key={t.id} trade={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
