import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import type { AgentSnapshotResponse, ProfileMe } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { cnm } from '@/utils/style'
import { config } from '@/config'
import { suiscanObjectUrl } from '@/utils/format'

function shortId(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return '—'
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

const POOL_LABEL: Record<string, string> = {
  '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5':
    'SUI/DBUSDC',
  '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f':
    'DEEP/SUI',
  '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a':
    'WAL/SUI',
}

function resolvePoolNames(ids: Array<string>): string {
  if (ids.length === 0) return '—'
  return ids.map((id) => POOL_LABEL[id] ?? shortId(id)).join(', ')
}

function fmtExpiry(ms: string | undefined): string {
  if (!ms) return '—'
  try {
    const diff = Number(ms) - Date.now()
    if (diff <= 0) return 'expired'
    const totalMin = Math.floor(diff / 60_000)
    if (totalMin < 1) return '< 1 min'
    if (totalMin < 60) return `in ${totalMin}m`
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h < 24) return `in ${h}h ${m}m`
    return `in ${Math.floor(h / 24)}d`
  } catch {
    return '—'
  }
}

// FLOAT_SCALING'd (1e9) BigInt-string → human DBUSDC notional (assume DBUSDC).
// Budget unit on the agent is FLOAT_SCALING'd quote, so divide by 1e9.
function fmtNotional(scaled: string | undefined): string {
  if (!scaled) return '—'
  try {
    const n = Number(BigInt(scaled)) / 1_000_000_000
    if (!Number.isFinite(n)) return scaled
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  } catch {
    return scaled
  }
}

function pct(spent: string | undefined, max: string | undefined): number {
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

interface Props {
  profile: ProfileMe
}

export function ProfileCard({ profile }: Props) {
  const { refresh } = useAuth()
  void refresh

  const { data: agent, isLoading } = useQuery<AgentSnapshotResponse>({
    queryKey: ['agent', 'snapshot', profile.suiAddress],
    queryFn: () => apiFetch<AgentSnapshotResponse>('/agent/snapshot'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const snap = agent?.snapshot
  const usagePct = pct(snap?.spent_today, snap?.max_notional_per_day)
  const explorer = `${config.links.explorerBase}/account/${profile.suiAddress}`

  return (
    <Card className="p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Trader profile
          </p>
          <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.02em] mb-2 truncate">
            {profile.suinsName ?? shortId(profile.suiAddress, 8, 6)}
          </h2>
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-lh-text-dim hover:text-lh-accent transition-colors"
          >
            {profile.suiAddress}
          </a>

          <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <LinkedRow
              label="Profile object"
              value={shortId(profile.profileObjectId, 10, 6)}
              href={suiscanObjectUrl(profile.profileObjectId)}
            />
            <LinkedRow
              label="BalanceManager"
              value={shortId(profile.balanceManagerId, 10, 6)}
              href={profile.balanceManagerId ? suiscanObjectUrl(profile.balanceManagerId) : null}
            />
            <LinkedRow
              label="ExecutorAgent"
              value={shortId(profile.executorAgentId, 10, 6)}
              href={profile.executorAgentId ? suiscanObjectUrl(profile.executorAgentId) : null}
            />
            <LinkedRow
              label="MemWal account"
              value={shortId(profile.memwalAccountId, 10, 6)}
              href={profile.memwalAccountId ? suiscanObjectUrl(profile.memwalAccountId) : null}
            />
          </dl>
        </div>

        <div className="md:min-w-[280px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
            Daily executor budget
          </p>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : !agent?.ready || !snap ? (
            <p className="text-sm text-lh-text-dim">
              No executor agent yet. Run setup-trading from the Telegram bot.
            </p>
          ) : (
            <>
              <div className="flex items-end justify-between mb-1">
                <span className="text-lg font-semibold tabular-nums">
                  {fmtNotional(snap.spent_today)}{' '}
                  <span className="text-lh-text-dim text-sm font-normal">
                    DBUSDC
                  </span>
                </span>
                <span className="text-xs text-lh-text-mute tabular-nums">
                  of {fmtNotional(snap.max_notional_per_day)}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-lh-line overflow-hidden">
                <div
                  className={cnm(
                    'h-full',
                    snap.revoked ? 'bg-red-500/70' : 'bg-lh-accent',
                  )}
                  style={{ width: `${usagePct}%` }}
                />
              </div>
              <dl className="mt-4 space-y-2 text-xs text-lh-text-dim">
                <Row
                  label="Per-trade cap"
                  value={`${fmtNotional(snap.max_notional_per_trade)} DBUSDC`}
                />
                <Row
                  label="Pools allowed"
                  value={resolvePoolNames(snap.allowed_pools)}
                />
                <Row
                  label="Status"
                  value={snap.revoked ? 'revoked' : 'active'}
                  emphasize={snap.revoked ? 'danger' : 'accent'}
                />
                <Row label="Resets" value={fmtExpiry(snap.expires_at_ms)} />
              </dl>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

function Row({
  label,
  value,
  emphasize,
}: {
  label: string
  value: string
  emphasize?: 'accent' | 'danger'
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-lh-text-mute text-xs uppercase tracking-[0.12em] font-mono shrink-0">
        {label}
      </dt>
      <dd
        className={cnm(
          'font-mono tabular-nums text-sm truncate text-right',
          emphasize === 'danger' && 'text-red-400',
          emphasize === 'accent' && 'text-lh-accent',
          !emphasize && 'text-lh-text-dim',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function LinkedRow({
  label,
  value,
  href,
}: {
  label: string
  value: string
  href: string | null
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-lh-text-mute text-xs uppercase tracking-[0.12em] font-mono shrink-0">
        {label}
      </dt>
      <dd className="font-mono tabular-nums text-sm truncate text-right">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-lh-text-dim hover:text-lh-accent transition-colors"
          >
            {value}
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        ) : (
          <span className="text-lh-text-dim">{value}</span>
        )}
      </dd>
    </div>
  )
}
