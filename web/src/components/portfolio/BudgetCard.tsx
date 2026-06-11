import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import type { AgentSnapshotResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { useAuth } from '@/hooks/useAuth'

const POOL_LABEL: Record<string, string> = {
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5':
    'SUI/DBUSDC',
  '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f':
    'DEEP/SUI',
  '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a':
    'WAL/SUI',
}

function shortId(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

// FLOAT_SCALING'd (1e9) BigInt string → human DBUSDC decimal string.
function fmtNotional(scaled: string | undefined): string {
  if (!scaled) return '—'
  try {
    const n = Number(BigInt(scaled)) / 1_000_000_000
    if (!Number.isFinite(n)) return scaled
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  } catch {
    return scaled
  }
}

function calcPct(spent: string | undefined, max: string | undefined): number {
  if (!spent || !max) return 0
  try {
    const s = Number(BigInt(spent))
    const m = Number(BigInt(max))
    if (m <= 0) return 0
    return Math.min(100, Math.max(0, (s / m) * 100))
  } catch {
    return 0
  }
}

function fmtExpiry(ms: string | undefined): string {
  if (!ms) return '—'
  try {
    const diff = Number(ms) - Date.now()
    if (diff <= 0) return 'expired'
    const totalMin = Math.floor(diff / 60_000)
    if (totalMin < 1) return '< 1 min'
    if (totalMin < 60) return `${totalMin}m`
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h < 24) return `${h}h ${m}m`
    return `${Math.floor(h / 24)}d ${h % 24}h`
  } catch {
    return '—'
  }
}

function resolvePoolNames(ids: Array<string>): string {
  if (ids.length === 0) return '—'
  return ids.map((id) => POOL_LABEL[id] ?? shortId(id)).join(', ')
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-lh-text-dim">
        {value}
      </span>
    </div>
  )
}

export function BudgetCard() {
  const { profile } = useAuth()

  const { data, isLoading } = useQuery<AgentSnapshotResponse>({
    queryKey: ['agent', 'snapshot', profile?.suiAddress ?? ''],
    queryFn: () => apiFetch<AgentSnapshotResponse>('/agent/snapshot'),
    enabled: !!profile,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })

  const snap = data?.snapshot
  const pct = calcPct(snap?.spent_today, snap?.max_notional_per_day)

  const barColor =
    snap?.revoked
      ? 'bg-red-500/80'
      : pct >= 80
        ? 'bg-red-500/80'
        : pct >= 50
          ? 'bg-amber-400/90'
          : 'bg-lh-accent'

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="none" className="mb-4">
        Daily Budget
      </EyebrowTag>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : !data?.ready || !snap ? (
        <div className="space-y-2">
          <p className="text-sm text-lh-text-dim">
            No executor agent configured.
          </p>
          <p className="text-xs text-lh-text-mute">
            Complete setup from the Telegram bot to see your daily budget here.
          </p>
        </div>
      ) : (
        <>
          {snap.revoked && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
              <span className="text-xs font-mono text-red-400">
                Agent revoked.{' '}
                <Link
                  to="/portfolio"
                  className="underline underline-offset-2 hover:text-red-300 transition-colors"
                >
                  Re-authorise in Portfolio
                </Link>
              </span>
            </div>
          )}

          {/* Spent / cap */}
          <div className="flex items-end justify-between mb-2">
            <div>
              <span className="text-2xl font-bold tabular-nums tracking-[-0.02em]">
                ${fmtNotional(snap.spent_today)}
              </span>
              <span className="ml-1 text-sm text-lh-text-mute font-normal">
                spent
              </span>
            </div>
            <span className="font-mono text-xs tabular-nums text-lh-text-mute">
              / ${fmtNotional(snap.max_notional_per_day)} cap
            </span>
          </div>

          {/* Progress bar */}
          <div
            className="h-1.5 w-full rounded-full bg-lh-line overflow-hidden mb-1"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cnm('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="font-mono text-[10px] tabular-nums text-lh-text-mute mb-5">
            {Math.round(pct)}% of daily limit used
          </p>

          {/* Stats grid */}
          <div className="space-y-2 border-t border-lh-line pt-4">
            <StatRow
              label="Per-trade cap"
              value={`$${fmtNotional(snap.max_notional_per_trade)}`}
            />
            <StatRow
              label="Agent expires"
              value={fmtExpiry(snap.expires_at_ms)}
            />
            <StatRow
              label="Allowed pools"
              value={
                snap.allowed_pools.length === 0
                  ? '—'
                  : `${snap.allowed_pools.length} (${resolvePoolNames(snap.allowed_pools)})`
              }
            />
            <StatRow
              label="Status"
              value={snap.revoked ? 'revoked' : 'active'}
            />
          </div>
        </>
      )}
    </Card>
  )
}
