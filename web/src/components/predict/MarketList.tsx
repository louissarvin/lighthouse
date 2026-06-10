import { useQuery } from '@tanstack/react-query'

import type { PredictMarket, PredictMarketsResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

interface Props {
  selectedOracleId?: string | null
  onSelect: (m: PredictMarket) => void
}

function fmtStrike(strike: string): string {
  // Predict strike is FLOAT_SCALING'd (1e9) quote-per-base.
  try {
    const n = Number(BigInt(strike)) / 1_000_000_000
    if (!Number.isFinite(n)) return strike
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  } catch {
    return strike
  }
}

function fmtExpiry(ms: string): string {
  try {
    const d = new Date(Number(BigInt(ms)))
    const now = Date.now()
    const diff = d.getTime() - now
    if (diff <= 0) return 'expired'
    const h = Math.floor(diff / 3_600_000)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  } catch {
    return ms
  }
}

export function MarketList({ selectedOracleId, onSelect }: Props) {
  const { data, isLoading, isError } = useQuery<PredictMarketsResponse>({
    queryKey: ['predict', 'markets'],
    queryFn: () => apiFetch<PredictMarketsResponse>('/predict/markets'),
    refetchInterval: 30_000,
    staleTime: 25_000,
  })

  const markets = (data?.markets ?? []).filter((m) => {
    try {
      return BigInt(m.expiry_ms) > BigInt(Date.now())
    } catch {
      return true
    }
  })

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold">Active markets</h3>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          DeepBook Predict
        </span>
      </div>

      {data?.stale && (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          Stub data — upstream predict-server is unreachable. Mints still
          succeed when the server is up.
        </p>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          Predict markets temporarily unavailable
        </p>
      )}

      {!isLoading && !isError && markets.length === 0 && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          No active markets right now. Check back in a few minutes.
        </p>
      )}

      <ul className="space-y-3">
        {markets.map((m) => {
          const selected = selectedOracleId === m.oracle_id
          return (
            <li key={m.oracle_id}>
              <button
                type="button"
                onClick={() => onSelect(m)}
                className={cnm(
                  'w-full text-left rounded-2xl border p-4 transition-colors',
                  selected
                    ? 'border-lh-accent bg-lh-accent/5'
                    : 'border-lh-line hover:border-lh-line-mid hover:bg-lh-bg/30',
                )}
              >
                <div className="flex items-baseline justify-between mb-1">
                  <p className="text-base font-semibold text-lh-text">
                    {m.symbol ?? 'Market'} ≥ {fmtStrike(m.strike)}
                  </p>
                  <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
                    in {fmtExpiry(m.expiry_ms)}
                  </span>
                </div>
                <div className="flex gap-3 text-xs text-lh-text-dim">
                  {typeof m.mid_implied_up_bps === 'number' && (
                    <span>UP {(m.mid_implied_up_bps / 100).toFixed(1)}%</span>
                  )}
                  {typeof m.mid_implied_down_bps === 'number' && (
                    <span>
                      DOWN {(m.mid_implied_down_bps / 100).toFixed(1)}%
                    </span>
                  )}
                </div>
                {m._note && (
                  <p className="text-[11px] text-amber-300 mt-2">{m._note}</p>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
