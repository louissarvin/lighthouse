import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useParams } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'

import type {
  FollowFeedResponse,
  FollowFeedTrade,
  PublicProfileResponse,
} from '@/lib/types'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { requireAuth } from '@/lib/requireAuth'
import { walrusBlobUrl } from '@/lib/walrus'
import { config } from '@/config'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/follow/$address')({
  beforeLoad: requireAuth,
  component: FollowFeedPage,
  head: ({ params }) => ({
    meta: [
      {
        title: `Following ${params.address.slice(0, 10)}… · Lighthouse`,
      },
      { name: 'robots', content: 'noindex' },
      {
        name: 'description',
        content: 'Live read-only trade feed for a Lighthouse trader you follow.',
      },
    ],
  }),
})

function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function fmtNumber(n: string | number, decimals = 4): string {
  const num = typeof n === 'string' ? parseFloat(n) : n
  if (Number.isNaN(num)) return String(n)
  return num.toLocaleString('en-US', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  })
}

function FollowFeedPage() {
  const { address } = useParams({ from: '/follow/$address' })

  const feedQuery = useQuery<FollowFeedResponse>({
    queryKey: ['follow', 'feed', address],
    queryFn: () =>
      apiFetch<FollowFeedResponse>(`/follow/feed/${encodeURIComponent(address)}`),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

  // Try to load public profile by SuiNS if the feed response includes a name.
  const suinsName = feedQuery.data?.profile?.suinsName
  const profileQuery = useQuery<PublicProfileResponse>({
    queryKey: ['public-profile', suinsName],
    queryFn: () =>
      apiFetch<PublicProfileResponse>(
        `/profile/by-suins/${encodeURIComponent(suinsName ?? '')}`,
        { noCredentials: true },
      ),
    enabled: !!suinsName,
    staleTime: 60_000,
  })

  const feedProfile = feedQuery.data?.profile
  const displayName =
    profileQuery.data?.suinsName ??
    feedProfile?.suinsName ??
    shortAddr(address)

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <div className="max-w-3xl mx-auto">
            {/* Header */}
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
              Copy-trader feed · read-only
            </p>
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 mb-2">
              <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em]">
                Following{' '}
                {suinsName ? (
                  <Link
                    to="/u/$name"
                    params={{ name: suinsName }}
                    className="text-lh-accent hover:underline"
                  >
                    {displayName}
                  </Link>
                ) : (
                  <span className="font-mono">{shortAddr(address)}</span>
                )}
              </h1>
            </div>
            <p className="text-sm text-lh-text-dim leading-relaxed mb-8 max-w-xl">
              You're viewing this trader's live feed. Trades are read-only — automatic copy-trading is coming soon.
            </p>

            {/* Profile summary */}
            {(feedProfile || profileQuery.data) && (
              <TraderSummary
                address={address}
                suinsName={suinsName ?? null}
                totalTrades={
                  feedProfile?.totalTrades ??
                  profileQuery.data?.counts.tradesPlaced ??
                  null
                }
                winRate={feedProfile?.winRate ?? null}
              />
            )}

            {/* Feed */}
            <div className="space-y-4">
              {feedQuery.isLoading && (
                <div className="space-y-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              )}

              {feedQuery.isError && (
                <Card className="p-6 text-center">
                  <p className="text-sm text-lh-text-dim">
                    {feedQuery.error.message || 'Failed to load feed.'}
                  </p>
                </Card>
              )}

              {feedQuery.data?.unavailable && (
                <Card className="p-6 text-center">
                  <p className="text-sm text-lh-text-dim">
                    Follow feed is pending backend wire-up
                    {feedQuery.data.reason
                      ? `: ${feedQuery.data.reason}`
                      : ''}
                    .
                  </p>
                </Card>
              )}

              {feedQuery.data &&
                !feedQuery.data.unavailable &&
                feedQuery.data.trades.length === 0 && (
                  <Card className="p-8 text-center">
                    <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-3">
                      No trades yet
                    </p>
                    <p className="text-sm text-lh-text-dim leading-relaxed">
                      This trader hasn't placed any trades yet, or none are
                      visible in their feed.
                    </p>
                  </Card>
                )}

              {feedQuery.data &&
                !feedQuery.data.unavailable &&
                feedQuery.data.trades.map((trade) => (
                  <TradeRow key={trade.id} trade={trade} />
                ))}
            </div>
          </div>
        </Container>
      </section>
    </main>
  )
}

function TraderSummary({
  address,
  suinsName,
  totalTrades,
  winRate,
}: {
  address: string
  suinsName: string | null
  totalTrades: number | null
  winRate: number | null
}) {
  return (
    <Card className="p-6 mb-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Gravatar */}
        <img
          src={`https://www.gravatar.com/avatar/${address.slice(2, 34)}?d=identicon&s=80`}
          alt=""
          aria-hidden="true"
          width={48}
          height={48}
          className="rounded-full border border-lh-line w-12 h-12 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">
            {suinsName ? `${suinsName}.sui` : shortAddr(address)}
          </p>
          <p className="font-mono text-xs text-lh-text-mute break-all">
            <a
              href={`${config.links.explorerBase}/account/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-lh-accent transition-colors"
            >
              {address}
            </a>
          </p>
        </div>
        <div className="flex gap-6 shrink-0">
          {totalTrades !== null && (
            <div className="text-center">
              <p className="text-xl font-bold tabular-nums">
                {totalTrades.toLocaleString('en-US')}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
                Trades
              </p>
            </div>
          )}
          {winRate !== null && (
            <div className="text-center">
              <p className="text-xl font-bold tabular-nums">
                {(winRate * 100).toFixed(1)}%
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
                Win rate
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function TradeRow({ trade }: { trade: FollowFeedTrade }) {
  const isBuy = trade.side === 'bid'
  const blobUrl = walrusBlobUrl(trade.walrusBlobId)

  return (
    <div className="rounded-2xl border border-lh-line bg-lh-bg-elev/60 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {/* Side badge */}
        <span
          className={cnm(
            'inline-flex items-center rounded-full px-3 py-0.5',
            'font-mono text-xs font-semibold uppercase tracking-[0.12em]',
            isBuy
              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25'
              : 'bg-red-500/10 text-red-300 border border-red-500/25',
          )}
        >
          {isBuy ? 'Buy' : 'Sell'}
        </span>

        <span className="font-mono text-sm text-lh-text font-semibold">
          {trade.pool}
        </span>

        <span className="font-mono text-[11px] text-lh-text-mute ml-auto">
          {relTime(trade.createdAt)}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs mb-3">
        <DataPoint label="Price" value={fmtNumber(trade.price)} />
        <DataPoint label="Qty" value={fmtNumber(trade.quantity)} />
        <DataPoint
          label="Notional"
          value={`$${fmtNumber(trade.notional, 2)}`}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        {trade.txDigest && (
          <a
            href={`${config.links.explorerBase}/tx/${trade.txDigest}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-mono text-lh-text-mute hover:text-lh-accent transition-colors"
          >
            Tx {trade.txDigest.slice(0, 10)}…
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        )}
        {blobUrl && (
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-mono text-lh-text-mute hover:text-lh-accent transition-colors"
          >
            Walrus blob
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  )
}

function DataPoint({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-0.5">
        {label}
      </p>
      <p className="font-mono text-lh-text tabular-nums">{value}</p>
    </div>
  )
}
