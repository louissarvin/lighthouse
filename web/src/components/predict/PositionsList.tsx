import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { PredictPosition, PredictPositionsResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { ApiError, apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { cnm } from '@/utils/style'

const DUSDC_TYPE_TAG =
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC'

interface Props {
  managerId: string | null
}

function fmtQuantity(raw: string): string {
  try {
    const n = Number(BigInt(raw)) / 1_000_000
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  } catch {
    return raw
  }
}

function fmtStrike(raw: string): string {
  try {
    return (Number(BigInt(raw)) / 1_000_000_000).toLocaleString('en-US', {
      maximumFractionDigits: 4,
    })
  } catch {
    return raw
  }
}

function fmtExpiry(ms: number | null | undefined): string {
  if (!ms) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return 'expired'
  const h = Math.floor(diff / 3_600_000)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function PositionsList({ managerId }: Props) {
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [claiming, setClaiming] = useState<string | null>(null)
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({})

  const { data, isLoading, isError } = useQuery<PredictPositionsResponse>({
    queryKey: ['predict', 'positions-own'],
    queryFn: async () => {
      try {
        return await apiFetch<PredictPositionsResponse>(
          '/predict/positions-own',
        )
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
          // positions-own not yet available — fall back to managerId path
          if (!managerId) return { positions: [], stale: true }
          try {
            return await apiFetch<PredictPositionsResponse>(
              `/predict/positions/${encodeURIComponent(managerId)}`,
            )
          } catch (inner) {
            if (inner instanceof ApiError && inner.status === 404) {
              return { positions: [], stale: true }
            }
            throw inner
          }
        }
        throw e
      }
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const positions = data?.positions ?? []

  const open = positions.filter((p) => p.status === 'open')
  const won = positions.filter((p) => p.status === 'settled')
  const history = positions.filter(
    (p) =>
      p.status === 'redeemed' ||
      (p.status !== 'open' && p.status !== 'settled'),
  )

  const wonCount =
    won.length + history.filter((p) => p.status === 'redeemed').length
  const lostCount = history.filter((p) => p.status !== 'redeemed').length
  const totalSettled = wonCount + lostCount
  const winRate =
    totalSettled > 0 ? Math.round((wonCount / totalSettled) * 100) : null

  async function claim(pos: PredictPosition) {
    if (!managerId || !pos.predict_id) return
    const key = pos.predict_id
    setClaiming(key)
    setClaimErrors((prev) => ({ ...prev, [key]: '' }))
    try {
      const built = await apiFetch<{ digest: string; bytes: string }>(
        '/predict/redeem',
        {
          method: 'POST',
          body: {
            predictObjectId: pos.predict_id,
            managerObjectId: managerId,
            oracleObjectId: pos.oracle_id,
            quoteTypeTag: DUSDC_TYPE_TAG,
            oracleId: pos.oracle_id,
            expiryMs: pos.expiry_ms?.toString() ?? '0',
            strike: pos.strike.toString(),
            isUp: pos.is_up,
            quantity: pos.quantity.toString(),
          },
        },
      )
      await execSponsored(built)
      void qc.invalidateQueries({ queryKey: ['predict', 'positions-own'] })
      void qc.invalidateQueries({ queryKey: ['predict', 'pnl'] })
      void qc.invalidateQueries({ queryKey: ['agent', 'balances'] })
    } catch (e) {
      setClaimErrors((prev) => ({
        ...prev,
        [key]: (e as Error).message,
      }))
    } finally {
      setClaiming(null)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold">Your positions</h3>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          PredictManager
        </span>
      </div>

      {!managerId && (
        <p className="text-sm text-lh-text-dim">
          Create a PredictManager to start minting positions.
        </p>
      )}

      {managerId && isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {managerId && isError && (
        <p className="text-sm text-lh-text-dim">
          Position index unavailable. Open mints still settle on-chain.
        </p>
      )}

      {managerId && !isLoading && positions.length === 0 && (
        <p className="text-sm text-lh-text-dim">
          No positions yet. Mint your first UP / DOWN.
        </p>
      )}

      {positions.length > 0 && (
        <div className="space-y-6">
          {won.length > 0 && (
            <section>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-accent mb-2">
                Won — Claim Now
              </p>
              <ul className="divide-y divide-lh-line">
                {won.map((p) => {
                  const key = p.predict_id ?? p.oracle_id
                  const isClaiming = claiming === p.predict_id
                  const claimErr = p.predict_id ? claimErrors[p.predict_id] : ''
                  return (
                    <li key={key} className="py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-xs text-lh-text">
                            {p.oracle_id.slice(0, 16)}…
                          </p>
                          <p className="text-xs text-lh-text-mute">
                            {p.is_up ? 'UP' : 'DOWN'} · strike{' '}
                            {fmtStrike(p.strike)} · {fmtQuantity(p.quantity)}{' '}
                            DUSDC · {fmtExpiry(p.expiry_ms)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => claim(p)}
                          disabled={isClaiming || !p.predict_id}
                          className={cnm(
                            'shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors',
                            isClaiming || !p.predict_id
                              ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
                              : 'bg-lh-accent text-lh-bg hover:bg-lh-accent-warm',
                          )}
                        >
                          {isClaiming ? 'Claiming…' : 'Claim'}
                        </button>
                      </div>
                      {claimErr && (
                        <p className="mt-1.5 text-xs text-red-400" role="alert">
                          {claimErr}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {open.length > 0 && (
            <section>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-2">
                Open
              </p>
              <ul className="divide-y divide-lh-line">
                {open.map((p, i) => (
                  <li
                    key={`${p.oracle_id}-${i}`}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-lh-text">
                        {p.oracle_id.slice(0, 16)}…
                      </p>
                      <p className="text-xs text-lh-text-mute">
                        strike {fmtStrike(p.strike)} · {fmtExpiry(p.expiry_ms)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={
                          p.is_up
                            ? 'text-emerald-400 text-sm'
                            : 'text-red-400 text-sm'
                        }
                      >
                        {p.is_up ? 'UP' : 'DOWN'}
                      </p>
                      <p className="font-mono text-xs text-lh-text-mute tabular-nums">
                        {fmtQuantity(p.quantity)} DUSDC
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {history.length > 0 && (
            <section>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-2">
                History
              </p>
              <ul className="divide-y divide-lh-line">
                {history.map((p, i) => (
                  <li
                    key={`${p.oracle_id}-history-${i}`}
                    className="flex items-center justify-between py-3 opacity-60"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-lh-text">
                        {p.oracle_id.slice(0, 16)}…
                      </p>
                      <p className="text-xs text-lh-text-mute capitalize">
                        {p.status}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-lh-text-mute">
                        {p.is_up ? 'UP' : 'DOWN'}
                      </p>
                      <p className="font-mono text-xs text-lh-text-mute tabular-nums">
                        {fmtQuantity(p.quantity)} DUSDC
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {winRate !== null && (
            <p className="font-mono text-[11px] text-lh-text-mute pt-2 border-t border-lh-line">
              {wonCount}W / {lostCount}L —{' '}
              <span className="text-lh-accent">{winRate}%</span> win rate
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
