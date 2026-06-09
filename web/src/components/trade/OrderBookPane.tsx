import { useQuery } from '@tanstack/react-query'

import type { BookLevel, OrderBookSnapshot } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

interface Props {
  poolKey: string
  levels?: number
  onPickPrice?: (price: string, side: 'bid' | 'ask') => void
}

function fmtPrice(p: string, quoteDecimals: number): string {
  const n = Number(p)
  if (!Number.isFinite(n)) return p
  // Use up to quoteDecimals significant digits, but cap UI to 4 for readability.
  const digits = Math.min(4, quoteDecimals)
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })
}

function fmtQty(q: string): string {
  const n = Number(q)
  if (!Number.isFinite(n)) return q
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })
}

export function OrderBookPane({ poolKey, levels = 10, onPickPrice }: Props) {
  const { data, isLoading, isError } = useQuery<OrderBookSnapshot>({
    queryKey: ['deepbook', 'book', poolKey, levels],
    queryFn: () =>
      apiFetch<OrderBookSnapshot>(`/deepbook/book/${poolKey}?levels=${levels}`),
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
    staleTime: 1000,
    retry: 1,
  })

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-lh-line flex items-baseline justify-between">
        <div>
          <h3 className="text-base font-semibold">
            {data
              ? `${data.base} / ${data.quote}`
              : poolKey.replace('_', ' / ')}
          </h3>
          <p className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
            DeepBook v3 · {levels} levels
          </p>
        </div>
        {data?.mid && (
          <div className="text-right">
            <p className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
              Mid
            </p>
            <p className="font-mono tabular-nums text-lh-accent">
              {fmtPrice(data.mid, data.quoteDecimals)}
            </p>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="p-6 space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="p-8 text-sm text-lh-text-dim text-center">
          Order book temporarily unavailable
        </p>
      )}

      {!isLoading && !isError && data && (
        <div className="grid grid-cols-1">
          <BookSide
            rows={data.asks.slice().reverse()}
            side="ask"
            quoteDecimals={data.quoteDecimals}
            onPick={onPickPrice}
          />
          <div className="bg-lh-bg/40 border-y border-lh-line px-6 py-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
                Spread
              </span>
              <span className="font-mono text-sm tabular-nums text-lh-text">
                {data.mid ? fmtPrice(data.mid, data.quoteDecimals) : '—'}
              </span>
            </div>
          </div>
          <BookSide
            rows={data.bids}
            side="bid"
            quoteDecimals={data.quoteDecimals}
            onPick={onPickPrice}
          />
        </div>
      )}
    </Card>
  )
}

interface BookSideProps {
  rows: Array<BookLevel>
  side: 'bid' | 'ask'
  quoteDecimals: number
  onPick?: (price: string, side: 'bid' | 'ask') => void
}

function BookSide({ rows, side, quoteDecimals, onPick }: BookSideProps) {
  if (rows.length === 0) {
    return (
      <p className="px-6 py-4 text-xs text-lh-text-mute text-center">
        No {side === 'bid' ? 'bids' : 'asks'} on this side
      </p>
    )
  }
  // Find max total so depth bars can be normalized.
  const maxTotal = Math.max(
    1,
    ...rows.map((r) => {
      const n = Number(r.total)
      return Number.isFinite(n) ? n : 0
    }),
  )

  return (
    <div className="divide-y divide-lh-line/60">
      {rows.map((r, i) => {
        const totalN = Number(r.total)
        const widthPct = Number.isFinite(totalN)
          ? Math.min(100, (totalN / maxTotal) * 100)
          : 0
        return (
          <button
            key={`${side}-${i}-${r.price}`}
            type="button"
            onClick={() => onPick?.(r.price, side)}
            className={cnm(
              'relative w-full grid grid-cols-3 gap-2 px-6 py-1.5 text-right',
              'hover:bg-lh-bg/40 transition-colors duration-150 group',
              'focus-visible:outline-none focus-visible:bg-lh-bg/40',
            )}
          >
            <span
              aria-hidden="true"
              className={cnm(
                'absolute inset-y-0 right-0 pointer-events-none',
                side === 'bid' ? 'bg-emerald-400/8' : 'bg-red-400/8',
                'group-hover:opacity-80 transition-opacity',
              )}
              style={{ width: `${widthPct}%` }}
            />
            <span
              className={cnm(
                'relative font-mono text-sm tabular-nums text-left',
                side === 'bid' ? 'text-emerald-400' : 'text-red-400',
              )}
            >
              {fmtPrice(r.price, quoteDecimals)}
            </span>
            <span className="relative font-mono text-sm tabular-nums text-lh-text">
              {fmtQty(r.quantity)}
            </span>
            <span className="relative font-mono text-xs tabular-nums text-lh-text-mute">
              {fmtQty(r.total)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
