import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'

import type { LeaderboardEntry, LeaderboardMetric, LeaderboardResponse } from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { walrusBlobUrl } from '@/lib/walrus'
import { formatNumberToKMB } from '@/utils/format'
import { cnm } from '@/utils/style'

// ────────────────────────────────────────────────────────────────────────
// Route
// ────────────────────────────────────────────────────────────────────────

const searchSchema = z.object({
  metric: z.enum(['trades', 'anchors', 'notional']).default('trades'),
  limit: z.number().int().min(10).max(100).default(50),
})

export const Route = createFileRoute('/leaderboard')({
  validateSearch: (s) => searchSchema.parse(s),
  component: LeaderboardPage,
  head: () => ({
    meta: [
      { title: 'Leaderboard · Lighthouse' },
      {
        name: 'description',
        content:
          'Top traders ranked by on-chain activity — trades placed, audit anchors, and total notional on Sui DeepBook.',
      },
    ],
  }),
})

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function hashColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  }
  const hue = Math.abs(h) % 360
  return `hsl(${hue} 55% 45%)`
}

function initials(suinsName: string | null | undefined, address: string): string {
  if (suinsName) {
    const clean = suinsName.replace(/\.sui$/, '')
    return clean.slice(0, 2).toUpperCase()
  }
  return address.replace(/^0x/, '').slice(0, 2).toUpperCase()
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function memberSince(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
}

function fmtNotional(raw: string): string {
  const n = parseFloat(raw)
  if (Number.isNaN(n)) return '—'
  return `$${formatNumberToKMB(n)}`
}

const METRIC_LABELS: Record<LeaderboardMetric, string> = {
  trades: 'Trades',
  anchors: 'Anchors',
  notional: 'Notional',
}

// ────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────

function LeaderboardPage() {
  const { metric, limit } = useSearch({ from: '/leaderboard' })
  const navigate = useNavigate({ from: '/leaderboard' })

  const { data, isLoading, isError, error } = useQuery<LeaderboardResponse>({
    queryKey: ['leaderboard', metric, limit],
    queryFn: () =>
      apiFetch<LeaderboardResponse>(
        `/leaderboard?metric=${encodeURIComponent(metric)}&limit=${limit}`,
        { noCredentials: true },
      ),
    staleTime: 30_000,
    retry: false,
  })

  function setMetric(m: LeaderboardMetric) {
    void navigate({ search: { metric: m, limit } })
  }

  function loadMore() {
    void navigate({ search: { metric, limit: 100 } })
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-4xl mx-auto">
            {/* Header */}
            <div className="mb-10">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
                Public rankings
              </p>
              <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
                Leaderboard
              </h1>
              <p className="text-lh-text-dim text-base max-w-lg">
                Top traders ranked by on-chain activity. All data is verifiable
                on Sui DeepBook and Walrus.
              </p>
            </div>

            {/* Metric tabs */}
            <div className="flex gap-1 mb-8 p-1 rounded-2xl bg-lh-bg-elev border border-lh-line w-fit">
              {(Object.keys(METRIC_LABELS) as Array<LeaderboardMetric>).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMetric(m)}
                  className={cnm(
                    'rounded-xl px-5 py-2 text-sm font-mono uppercase tracking-[0.12em]',
                    'transition-colors duration-150',
                    m === metric
                      ? 'bg-lh-accent text-lh-bg font-semibold'
                      : 'text-lh-text-dim hover:text-lh-text',
                  )}
                  aria-pressed={m === metric}
                >
                  {METRIC_LABELS[m]}
                </button>
              ))}
            </div>

            {/* Loading */}
            {isLoading && (
              <div className="space-y-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            )}

            {/* Error */}
            {isError && (
              <Card className="p-8 text-center">
                <p className="text-sm text-lh-text-dim">
                  {error.message || 'Failed to load leaderboard.'}
                </p>
              </Card>
            )}

            {/* Empty */}
            {data && data.entries.length === 0 && (
              <Card className="p-8 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-2">
                  No data yet
                </p>
                <p className="text-sm text-lh-text-dim">
                  The leaderboard will populate once traders have activity indexed.
                </p>
              </Card>
            )}

            {/* Table — desktop */}
            {data && data.entries.length > 0 && (
              <>
                <Card className="p-0 overflow-hidden hidden md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-lh-line bg-lh-bg/30">
                        <th className="py-3 pl-6 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute w-12">
                          Rank
                        </th>
                        <th className="py-3 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                          Trader
                        </th>
                        <th className="py-3 pr-4 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                          Trades
                        </th>
                        <th className="py-3 pr-4 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                          Anchors
                        </th>
                        <th className="py-3 pr-4 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                          Notional
                        </th>
                        <th className="py-3 pr-6 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                          Since
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-lh-line">
                      {data.entries.map((entry) => (
                        <TableRow key={entry.suiAddress} entry={entry} />
                      ))}
                    </tbody>
                  </table>
                </Card>

                {/* Cards — mobile */}
                <div className="md:hidden space-y-3">
                  {data.entries.map((entry) => (
                    <MobileCard key={entry.suiAddress} entry={entry} />
                  ))}
                </div>

                {/* Load more */}
                {limit < 100 && data.entries.length === limit && (
                  <div className="flex justify-center mt-6">
                    <button
                      type="button"
                      onClick={loadMore}
                      className={cnm(
                        'inline-flex items-center gap-2 rounded-full px-5 py-2.5',
                        'border border-lh-line text-lh-text-dim text-sm font-mono',
                        'uppercase tracking-[0.12em]',
                        'hover:text-lh-text hover:border-lh-accent/50 transition-colors',
                      )}
                    >
                      Load more
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </Container>
      </section>
      <FooterCard />
    </main>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Table row (desktop)
// ────────────────────────────────────────────────────────────────────────

function TableRow({ entry }: { entry: LeaderboardEntry }) {
  const avatarUrl = entry.avatarUrl ?? walrusBlobUrl(entry.avatarBlobId)
  const bg = hashColor(entry.suiAddress)
  const ini = initials(entry.suinsName, entry.suiAddress)
  const href = entry.suinsName
    ? `/u/${entry.suinsName}`
    : `/u/${entry.suiAddress}`

  return (
    <tr
      className="hover:bg-lh-bg/40 transition-colors cursor-pointer"
    >
      {/* Rank */}
      <td className="py-4 pl-6 pr-4 align-middle">
        <RankBadge rank={entry.rank} />
      </td>

      {/* Trader */}
      <td className="py-4 pr-4 align-middle">
        <Link to={href} className="flex items-center gap-3 group">
          <AvatarThumb avatarUrl={avatarUrl} bg={bg} ini={ini} />
          <div className="min-w-0">
            <p className="font-semibold text-lh-text group-hover:text-lh-accent transition-colors truncate">
              {entry.suinsName
                ? (entry.suinsName.endsWith('.sui') ? entry.suinsName : `${entry.suinsName}.sui`)
                : shortAddr(entry.suiAddress)}
            </p>
            {entry.suinsName && (
              <p className="font-mono text-[11px] text-lh-text-mute truncate">
                {shortAddr(entry.suiAddress)}
              </p>
            )}
          </div>
        </Link>
      </td>

      {/* Trades */}
      <td className="py-4 pr-4 text-right font-mono text-sm tabular-nums text-lh-text-dim">
        {entry.tradesPlaced.toLocaleString('en-US')}
      </td>

      {/* Anchors */}
      <td className="py-4 pr-4 text-right font-mono text-sm tabular-nums text-lh-text-dim">
        {entry.anchorCount.toLocaleString('en-US')}
      </td>

      {/* Notional */}
      <td className="py-4 pr-4 text-right font-mono text-sm tabular-nums text-lh-text-dim">
        {fmtNotional(entry.totalNotional)}
      </td>

      {/* Member since */}
      <td className="py-4 pr-6 text-right font-mono text-[11px] text-lh-text-mute">
        {memberSince(entry.memberSinceMs)}
      </td>
    </tr>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Mobile card
// ────────────────────────────────────────────────────────────────────────

function MobileCard({ entry }: { entry: LeaderboardEntry }) {
  const avatarUrl = entry.avatarUrl ?? walrusBlobUrl(entry.avatarBlobId)
  const bg = hashColor(entry.suiAddress)
  const ini = initials(entry.suinsName, entry.suiAddress)
  const href = entry.suinsName
    ? `/u/${entry.suinsName}`
    : `/u/${entry.suiAddress}`

  return (
    <Card className="p-5">
      <Link to={href} className="flex items-center gap-4">
        <RankBadge rank={entry.rank} />
        <AvatarThumb avatarUrl={avatarUrl} bg={bg} ini={ini} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-lh-text truncate">
            {entry.suinsName
              ? (entry.suinsName.endsWith('.sui') ? entry.suinsName : `${entry.suinsName}.sui`)
              : shortAddr(entry.suiAddress)}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
            <Stat label="Trades" value={entry.tradesPlaced.toLocaleString('en-US')} />
            <Stat label="Anchors" value={entry.anchorCount.toLocaleString('en-US')} />
            <Stat label="Notional" value={fmtNotional(entry.totalNotional)} />
          </div>
        </div>
      </Link>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3
  return (
    <span
      className={cnm(
        'inline-flex items-center justify-center w-8 h-8 rounded-full shrink-0',
        'font-mono text-sm font-bold tabular-nums',
        isTop3
          ? 'bg-lh-accent/15 text-lh-accent border border-lh-accent/30'
          : 'text-lh-text-mute bg-lh-bg border border-lh-line',
      )}
    >
      {rank}
    </span>
  )
}

function AvatarThumb({
  avatarUrl,
  bg,
  ini,
}: {
  avatarUrl: string | null
  bg: string
  ini: string
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden="true"
        width={36}
        height={36}
        className="w-9 h-9 rounded-full object-cover border border-lh-line shrink-0"
      />
    )
  }
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 select-none"
      style={{ background: bg }}
      aria-hidden="true"
    >
      {ini}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-lh-text-mute">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-lh-text-dim">
        {value}
      </span>
    </div>
  )
}
