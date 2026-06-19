import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useParams } from '@tanstack/react-router'
import { ArrowRight, ExternalLink, ShieldCheck } from 'lucide-react'

import type {
  PublicProfileRecentTrade,
  PublicProfileResponse,
  TearsheetListItem,
  TearsheetResponse,
} from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { TearsheetCard } from '@/components/tearsheet/TearsheetCard'
import { apiFetch } from '@/lib/api'
import { walrusBlobUrl } from '@/lib/walrus'
import { config } from '@/config'
import { formatNumberToKMB } from '@/utils/format'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/u/$name')({
  component: PublicProfilePage,
  head: ({ params }) => ({
    meta: [
      { title: `${params.name} · Lighthouse` },
      {
        name: 'description',
        content: `Public Lighthouse profile for ${params.name}. Verifiable trading activity on Sui + DeepBook, audit anchors on Walrus.`,
      },
      { property: 'og:title', content: `${params.name} on Lighthouse` },
      {
        property: 'og:description',
        content: `Verifiable AI trading profile for ${params.name}. Atoma + Walrus + Sui audit trail.`,
      },
    ],
  }),
})

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function relTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function memberSince(ms: number | null | undefined, iso?: string): string {
  const t = ms ?? (iso ? new Date(iso).getTime() : null)
  if (!t) return '—'
  return new Date(t).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
  })
}

/**
 * Deterministic color from a string hash — used for initials fallback so
 * the color is stable across renders and does not randomize on reload.
 */
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
  // First 2 hex chars after 0x prefix
  return address.replace(/^0x/, '').slice(0, 2).toUpperCase()
}

// ────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────

function PublicProfilePage() {
  const { name } = useParams({ from: '/u/$name' })

  const profileQuery = useQuery<PublicProfileResponse>({
    queryKey: ['public-profile', name],
    queryFn: () =>
      apiFetch<PublicProfileResponse>(
        `/profile/by-suins/${encodeURIComponent(name)}`,
        { noCredentials: true },
      ),
    retry: false,
    staleTime: 60_000,
  })

  const tearsheetQuery = useQuery<TearsheetResponse>({
    queryKey: ['public-profile', name, 'latest-tearsheet'],
    queryFn: () =>
      apiFetch<TearsheetResponse>(
        `/tearsheet/by-suins/${encodeURIComponent(name)}/latest`,
        { noCredentials: true },
      ),
    enabled: !!profileQuery.data?.latestTearsheet,
    retry: false,
    staleTime: 60_000,
  })

  const tearsheetListQuery = useQuery<Array<TearsheetListItem>>({
    queryKey: ['public-profile', name, 'tearsheet-list'],
    queryFn: () =>
      apiFetch<Array<TearsheetListItem>>(
        `/tearsheet/list/${encodeURIComponent(profileQuery.data?.suiAddress ?? '')}`,
        { noCredentials: true },
      ),
    enabled: !!profileQuery.data?.suiAddress,
    retry: false,
    staleTime: 120_000,
  })

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-4xl mx-auto">
            {profileQuery.isLoading && (
              <div className="space-y-6">
                <Skeleton className="h-56" />
                <Skeleton className="h-28" />
                <Skeleton className="h-48" />
              </div>
            )}

            {profileQuery.isError && (
              <Card className="p-8 text-center">
                <h1 className="text-2xl font-semibold tracking-[-0.02em] mb-3">
                  Profile not found
                </h1>
                <p className="text-sm text-lh-text-dim leading-relaxed mb-2">
                  {profileQuery.error.message ||
                    `No Lighthouse profile for ${name}.`}
                </p>
                <p className="font-mono text-xs text-lh-text-mute">{name}</p>
                <Link
                  to="/"
                  className="mt-6 inline-flex items-center gap-2 rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-5 py-2.5"
                >
                  Back home
                </Link>
              </Card>
            )}

            {profileQuery.data && (
              <div className="space-y-8">
                {/* Hero */}
                <ProfileHero data={profileQuery.data} />

                {/* Stats strip */}
                <StatsStrip data={profileQuery.data} />

                {/* Recent trades feed */}
                <RecentTradesFeed data={profileQuery.data} />

                {/* Follow CTA */}
                <FollowCTA address={profileQuery.data.suiAddress} />

                {/* Tearsheets */}
                <TearsheetSection
                  name={name}
                  data={profileQuery.data}
                  tearsheetData={tearsheetQuery.data ?? null}
                  tearsheetLoading={tearsheetQuery.isLoading}
                  tearsheetList={tearsheetListQuery.data ?? null}
                />

                {/* On-chain identity (collapsed detail) */}
                <OnChainIdentity data={profileQuery.data} />
              </div>
            )}
          </div>
        </Container>
      </section>
      <FooterCard />
    </main>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Hero
// ────────────────────────────────────────────────────────────────────────

function ProfileHero({ data }: { data: PublicProfileResponse }) {
  const name = data.suinsName
  const suinsDisplay = name
    ? name.endsWith('.sui')
      ? name
      : `${name}.sui`
    : null

  const avatarUrl = data.avatarUrl || walrusBlobUrl(data.avatarBlobId || null)
  const bgColor = hashColor(data.suiAddress)
  const avatarInitials = initials(name, data.suiAddress)

  const suiscanProfileUrl = `${config.links.explorerBase}/object/${data.profileObjectId}`
  const profilePath = name ? `/u/${name}` : `/u/${data.suiAddress}`
  const fullShareUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${profilePath}`
      : profilePath

  const memberMs = data.memberSinceMs || new Date(data.createdAt).getTime()

  return (
    <Card className="p-8">
      <div className="flex flex-col items-center text-center gap-4">
        {/* Avatar */}
        <div className="relative shrink-0">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={`${suinsDisplay ?? shortAddr(data.suiAddress)} avatar`}
              width={96}
              height={96}
              className="w-24 h-24 rounded-full object-cover border border-lh-line"
              // Security: avatarUrl is validated through walrusBlobUrl which
              // only allows the known aggregator base + blob path. No user-
              // controlled href injection possible here.
            />
          ) : (
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center text-white text-2xl font-bold tracking-tight select-none"
              style={{ background: bgColor }}
              aria-hidden="true"
            >
              {avatarInitials}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-[-0.03em] mb-1">
            {suinsDisplay ?? shortAddr(data.suiAddress)}
          </h1>
          <p className="font-mono text-xs text-lh-text-mute mb-2">
            {shortAddr(data.suiAddress)}
          </p>
          <p className="text-xs text-lh-text-dim">
            Member since {memberSince(memberMs)}
          </p>
        </div>

        {/* Verified badge */}
        <a
          href={suiscanProfileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cnm(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1',
            'border border-emerald-500/30 bg-emerald-500/8 text-emerald-400',
            'text-[11px] font-mono uppercase tracking-[0.12em]',
            'hover:bg-emerald-500/15 transition-colors',
          )}
        >
          <ShieldCheck size={11} strokeWidth={2} aria-hidden="true" />
          Verified on Sui
        </a>

        {/* Bio */}
        {data.bio && (
          <p className="max-w-md text-sm text-lh-text-dim italic leading-relaxed line-clamp-4">
            {data.bio}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap justify-center gap-2 mt-1">
          <a
            href={`${config.links.explorerBase}/account/${data.suiAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cnm(
              'inline-flex items-center gap-1.5 rounded-full px-4 py-2',
              'border border-lh-line bg-lh-bg/40',
              'text-xs font-mono uppercase tracking-[0.14em] text-lh-text-dim',
              'hover:text-lh-text hover:border-lh-accent/50 transition-colors',
            )}
          >
            Explorer
            <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
          </a>
          <ShareButton url={fullShareUrl} />
        </div>
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Stats strip
// ────────────────────────────────────────────────────────────────────────

function StatsStrip({ data }: { data: PublicProfileResponse }) {
  const trades = data.tradesPlaced != null ? data.tradesPlaced : data.counts.tradesPlaced
  const anchors = data.anchorCount != null ? data.anchorCount : data.counts.lighthouseAnchorsTotal
  const notionalRaw = data.totalNotional
  const notionalNum = notionalRaw ? parseFloat(notionalRaw) : null
  const notionalDisplay =
    notionalNum !== null && Number.isFinite(notionalNum)
      ? `$${formatNumberToKMB(notionalNum)}`
      : '—'
  const memberMs = data.memberSinceMs || new Date(data.createdAt).getTime()

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        label="Trades placed"
        value={trades.toLocaleString('en-US')}
        sub="DeepBook limit orders"
      />
      <StatCard
        label="Audit anchors"
        value={anchors.toLocaleString('en-US')}
        sub="On-chain trade receipts"
      />
      <StatCard
        label="Total notional"
        value={notionalDisplay}
        sub="Cumulative traded"
      />
      <StatCard
        label="Member since"
        value={memberSince(memberMs)}
        sub="zkLogin profile minted"
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub: string
}) {
  return (
    <Card className="p-5">
      <p className="font-mono uppercase tracking-[0.14em] text-[10px] text-lh-text-mute mb-2">
        {label}
      </p>
      <p className="text-2xl font-bold tracking-[-0.02em] tabular-nums mb-1">
        {value}
      </p>
      <p className="text-[11px] text-lh-text-mute leading-snug">{sub}</p>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Recent trades feed
// ────────────────────────────────────────────────────────────────────────

function RecentTradesFeed({ data }: { data: PublicProfileResponse }) {
  const trades = data.recentTrades

  if (!trades || trades.length === 0) return null

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="text-lg font-semibold">Recent trades</h2>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          DeepBook v3
        </span>
      </div>
      <div className="space-y-0 divide-y divide-lh-line">
        {trades.slice(0, 10).map((trade) => (
          <PublicTradeRow key={trade.id} trade={trade} />
        ))}
      </div>
    </Card>
  )
}

function PublicTradeRow({ trade }: { trade: PublicProfileRecentTrade }) {
  const isBuy = trade.side === 'bid'
  const price = safeDecimal(trade.price)
  const qty = safeDecimal(trade.quantity)
  const notional = safeDecimal(trade.notional)
  const blobUrl = walrusBlobUrl(trade.walrusBlobId)

  return (
    <div className="flex flex-wrap items-center gap-3 py-3.5">
      {/* Side badge */}
      <span
        className={cnm(
          'inline-flex items-center rounded-full px-3 py-0.5 shrink-0',
          'font-mono text-xs font-semibold uppercase tracking-[0.1em]',
          isBuy
            ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25'
            : 'bg-red-500/10 text-red-300 border border-red-500/25',
        )}
      >
        {isBuy ? 'Buy' : 'Sell'}
      </span>

      <span className="font-mono text-sm text-lh-text font-medium shrink-0">
        {trade.pool}
      </span>

      <div className="hidden sm:flex items-center gap-4 font-mono text-xs text-lh-text-dim">
        <span className="tabular-nums">{price}</span>
        <span className="text-lh-text-mute">×</span>
        <span className="tabular-nums">{qty}</span>
        <span className="text-lh-text-mute">=</span>
        <span className="tabular-nums">${notional}</span>
      </div>

      <div className="flex items-center gap-3 ml-auto">
        <span className="font-mono text-[11px] text-lh-text-mute">
          {relTime(trade.createdAt)}
        </span>
        {blobUrl && (
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-mono text-lh-text-mute hover:text-lh-accent transition-colors"
            aria-label="View Walrus blob"
          >
            Walrus
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        )}
        {trade.txDigest && (
          <a
            href={`${config.links.explorerBase}/tx/${trade.txDigest}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-mono text-lh-text-mute hover:text-lh-accent transition-colors"
            aria-label="View transaction on Suiscan"
          >
            Tx
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  )
}

function safeDecimal(val: string): string {
  const n = parseFloat(val)
  if (Number.isNaN(n)) return val
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

// ────────────────────────────────────────────────────────────────────────
// Follow CTA
// ────────────────────────────────────────────────────────────────────────

function FollowCTA({ address }: { address: string }) {
  return (
    <div className="flex justify-center">
      <Link
        to="/follow/$address"
        params={{ address }}
        className={cnm(
          'inline-flex items-center gap-2 rounded-full px-5 py-2.5',
          'border border-lh-line text-lh-text-dim text-sm font-mono',
          'uppercase tracking-[0.12em]',
          'hover:text-lh-accent hover:border-lh-accent/50 transition-colors',
        )}
      >
        Follow this trader
        <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
      </Link>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Tearsheets
// ────────────────────────────────────────────────────────────────────────

function TearsheetSection({
  name,
  data,
  tearsheetData,
  tearsheetLoading,
  tearsheetList,
}: {
  name: string
  data: PublicProfileResponse
  tearsheetData: TearsheetResponse | null
  tearsheetLoading: boolean
  tearsheetList: Array<TearsheetListItem> | null
}) {
  if (!data.latestTearsheet && (!tearsheetList || tearsheetList.length === 0)) {
    return (
      <Card className="p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
          No tearsheets yet
        </p>
        <p className="text-sm text-lh-text-dim">
          This trader has not published a weekly tearsheet to Walrus yet.
          Activity will appear here once the first Sunday rollup runs.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Latest tearsheet (rich card) */}
      {tearsheetData && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-xl font-semibold">Latest weekly tearsheet</h2>
            <Link
              to="/u/$name/$week"
              params={{ name, week: tearsheetData.week }}
              className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.14em] text-lh-accent hover:underline"
            >
              Open week
              <ArrowRight size={11} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
          <TearsheetCard data={tearsheetData} />
        </div>
      )}

      {/* Fallback when latest fetch failed */}
      {data.latestTearsheet && !tearsheetData && !tearsheetLoading && (
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Latest tearsheet
          </p>
          <p className="text-sm text-lh-text-dim mb-3">
            Week{' '}
            <span className="font-mono">{data.latestTearsheet.week}</span>.
            Walrus aggregator did not respond in time — open the full week page
            or fetch the raw blob directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/u/$name/$week"
              params={{ name, week: data.latestTearsheet.week }}
              className="inline-flex items-center gap-1 rounded-full border border-lh-line text-lh-text-dim text-xs font-mono uppercase tracking-[0.14em] px-3 py-1.5 hover:text-lh-accent hover:border-lh-accent/50"
            >
              Open week page
              <ArrowRight size={11} strokeWidth={2} aria-hidden="true" />
            </Link>
            <a
              href={data.latestTearsheet.publicTearsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-lh-line text-lh-text-dim text-xs font-mono uppercase tracking-[0.14em] px-3 py-1.5 hover:text-lh-accent hover:border-lh-accent/50"
            >
              Raw on Walrus
              <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
            </a>
          </div>
        </Card>
      )}

      {/* Historical tearsheet list */}
      {tearsheetList && tearsheetList.length > 1 && (
        <Card className="p-6">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-4">
            Public tearsheets
          </h3>
          <ul className="divide-y divide-lh-line">
            {tearsheetList.map((t) => (
              <li key={t.week} className="flex items-center justify-between py-3 gap-4">
                <div className="min-w-0">
                  <Link
                    to="/u/$name/$week"
                    params={{ name, week: t.week }}
                    className="font-mono text-sm text-lh-text hover:text-lh-accent transition-colors"
                  >
                    {t.week}
                  </Link>
                  {t.total_trades !== undefined && (
                    <p className="text-xs text-lh-text-mute">
                      {t.total_trades} trades
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {t.auditAnchorTxDigest && (
                    <a
                      href={`${config.links.explorerBase}/tx/${t.auditAnchorTxDigest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-lh-text-mute hover:text-lh-accent transition-colors inline-flex items-center gap-1"
                    >
                      Anchor
                      <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
                    </a>
                  )}
                  {t.publicTearsheetUrl && (
                    <a
                      href={t.publicTearsheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-lh-accent hover:text-lh-accent-warm transition-colors inline-flex items-center gap-1"
                    >
                      Open
                      <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// On-chain identity (detail card, secondary)
// ────────────────────────────────────────────────────────────────────────

function OnChainIdentity({ data }: { data: PublicProfileResponse }) {
  const explorer = config.links.explorerBase
  return (
    <Card className="p-6 md:p-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-4">
        On-chain identity
      </p>
      <dl className="space-y-3 text-sm">
        <IDRow
          label="Sui address"
          value={data.suiAddress}
          href={`${explorer}/account/${data.suiAddress}`}
        />
        <IDRow
          label="TraderProfile"
          value={data.profileObjectId}
          href={`${explorer}/object/${data.profileObjectId}`}
        />
        {data.balanceManagerId && (
          <IDRow
            label="BalanceManager"
            value={data.balanceManagerId}
            href={`${explorer}/object/${data.balanceManagerId}`}
          />
        )}
        {data.executorAgentId && (
          <IDRow
            label="ExecutorAgent"
            value={data.executorAgentId}
            href={`${explorer}/object/${data.executorAgentId}`}
          />
        )}
      </dl>
    </Card>
  )
}

function IDRow({
  label,
  value,
  href,
}: {
  label: string
  value: string
  href?: string
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
      <dt className="font-mono uppercase tracking-[0.14em] text-[10px] text-lh-text-mute sm:w-36 shrink-0">
        {label}
      </dt>
      <dd className="font-mono text-xs text-lh-text-dim break-all">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-lh-accent transition-colors"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Share button
// ────────────────────────────────────────────────────────────────────────

function ShareButton({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard.writeText(url)
        } catch {
          // ignore — user can copy manually
        }
      }}
      className={cnm(
        'inline-flex items-center gap-1.5 rounded-full px-4 py-2',
        'bg-lh-accent text-lh-bg font-semibold',
        'text-xs font-mono uppercase tracking-[0.14em]',
        'hover:bg-lh-accent/90 transition-colors',
      )}
      aria-label="Copy profile URL"
    >
      Copy URL
    </button>
  )
}
