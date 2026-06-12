import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useParams } from '@tanstack/react-router'
import { ArrowRight, ExternalLink } from 'lucide-react'

import type { PublicProfileResponse, TearsheetResponse } from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { TearsheetCard } from '@/components/tearsheet/TearsheetCard'
import { apiFetch } from '@/lib/api'
import { config } from '@/config'
import { cnm } from '@/utils/style'

/**
 * Public trader profile at `/u/<suins_name>`.
 *
 * This is the canonical share URL for a Lighthouse user: SuiNS resolves to a
 * Sui address, we summarise their public state (counts, latest tearsheet,
 * deep-links to the on-chain explorer + Walrus aggregator), and surface a
 * call-to-action to read the full weekly tearsheet at `/u/<name>/<week>`.
 *
 * Read-only, no auth.
 */
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

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    })
  } catch {
    return iso
  }
}

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

  // Optional: fetch the resolved latest tearsheet for richer surface.
  // We hit `/tearsheet/by-suins/<name>/latest` only when the profile query
  // confirms a latest tearsheet exists — saves a round-trip on profiles
  // that have not posted any weekly summary yet.
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

  const explorer = config.links.explorerBase

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-4xl mx-auto">
            {profileQuery.isLoading && (
              <div className="space-y-6">
                <Skeleton className="h-44" />
                <Skeleton className="h-32" />
                <Skeleton className="h-48" />
              </div>
            )}

            {profileQuery.error && !profileQuery.isLoading && (
              <Card className="p-8 text-center">
                <h1 className="text-2xl font-semibold tracking-[-0.02em] mb-3">
                  Profile not found
                </h1>
                <p className="text-sm text-lh-text-dim leading-relaxed mb-2">
                  {(profileQuery.error).message ??
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
                <HeaderCard data={profileQuery.data} />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <CountCard
                    label="Trades placed"
                    value={profileQuery.data.counts.tradesPlaced.toLocaleString(
                      'en-US',
                    )}
                    sub="DeepBook v3 limit orders, executor-gated"
                  />
                  <CountCard
                    label="Audit anchors (protocol)"
                    value={profileQuery.data.counts.lighthouseAnchorsTotal.toLocaleString(
                      'en-US',
                    )}
                    sub="Lighthouse-wide AnchorRecorded events"
                  />
                  <CountCard
                    label="Profile minted"
                    value={fmtDate(profileQuery.data.createdAt)}
                    sub="zkLogin + Enoki sponsored"
                  />
                </div>

                {/* Object IDs / explorer cluster */}
                <Card className="p-6 md:p-8">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-4">
                    On-chain identity
                  </p>
                  <dl className="space-y-3 text-sm">
                    <Row
                      label="Sui address"
                      value={profileQuery.data.suiAddress}
                      href={`${explorer}/account/${profileQuery.data.suiAddress}`}
                    />
                    <Row
                      label="TraderProfile"
                      value={profileQuery.data.profileObjectId}
                      href={`${explorer}/object/${profileQuery.data.profileObjectId}`}
                    />
                    {profileQuery.data.balanceManagerId && (
                      <Row
                        label="BalanceManager"
                        value={profileQuery.data.balanceManagerId}
                        href={`${explorer}/object/${profileQuery.data.balanceManagerId}`}
                      />
                    )}
                    {profileQuery.data.executorAgentId && (
                      <Row
                        label="ExecutorAgent"
                        value={profileQuery.data.executorAgentId}
                        href={`${explorer}/object/${profileQuery.data.executorAgentId}`}
                      />
                    )}
                  </dl>
                </Card>

                {/* Latest tearsheet (rich) — only when backend confirmed one */}
                {tearsheetQuery.data && (
                  <div>
                    <div className="flex items-baseline justify-between mb-3">
                      <h2 className="text-xl font-semibold">
                        Latest weekly tearsheet
                      </h2>
                      <Link
                        to="/u/$name/$week"
                        params={{
                          name,
                          week: tearsheetQuery.data.week,
                        }}
                        className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-[0.14em] text-lh-accent hover:underline"
                      >
                        Open week
                        <ArrowRight size={11} strokeWidth={2} />
                      </Link>
                    </div>
                    <TearsheetCard data={tearsheetQuery.data} />
                  </div>
                )}

                {profileQuery.data.latestTearsheet &&
                  !tearsheetQuery.data &&
                  !tearsheetQuery.isLoading && (
                    <Card className="p-6">
                      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
                        Latest tearsheet
                      </p>
                      <p className="text-sm text-lh-text-dim">
                        Week{' '}
                        <span className="font-mono">
                          {profileQuery.data.latestTearsheet.week}
                        </span>
                        . Walrus aggregator did not respond in time — open the
                        full week page or fetch the raw blob directly.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link
                          to="/u/$name/$week"
                          params={{
                            name,
                            week: profileQuery.data.latestTearsheet.week,
                          }}
                          className="inline-flex items-center gap-1 rounded-full border border-lh-line text-lh-text-dim text-xs font-mono uppercase tracking-[0.14em] px-3 py-1.5 hover:text-lh-accent hover:border-lh-accent/50"
                        >
                          Open week page
                          <ArrowRight size={11} strokeWidth={2} />
                        </Link>
                        <a
                          href={
                            profileQuery.data.latestTearsheet.publicTearsheetUrl
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-full border border-lh-line text-lh-text-dim text-xs font-mono uppercase tracking-[0.14em] px-3 py-1.5 hover:text-lh-accent hover:border-lh-accent/50"
                        >
                          Raw on Walrus
                          <ExternalLink size={11} strokeWidth={2} />
                        </a>
                      </div>
                    </Card>
                  )}

                {!profileQuery.data.latestTearsheet && (
                  <Card className="p-6">
                    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
                      No tearsheets yet
                    </p>
                    <p className="text-sm text-lh-text-dim">
                      This trader has not published a weekly tearsheet to Walrus
                      yet. Activity will appear here once the first Sunday
                      rollup runs.
                    </p>
                  </Card>
                )}
              </div>
            )}
          </div>
        </Container>
      </section>
      <FooterCard />
    </main>
  )
}

function HeaderCard({ data }: { data: PublicProfileResponse }) {
  const display = data.suinsName?.endsWith('.sui')
    ? data.suinsName
    : `${data.suinsName}.sui`
  return (
    <Card className="p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Lighthouse trader
          </p>
          <h1 className="text-4xl md:text-[56px] font-bold tracking-[-0.03em] mb-2 truncate">
            {display}
          </h1>
          <p className="text-sm text-lh-text-dim font-mono">
            {shortAddr(data.suiAddress)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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
            Open in Explorer
            <ExternalLink size={11} strokeWidth={2} />
          </a>
          <ShareButton url={`/u/${data.suinsName}`} />
        </div>
      </div>
    </Card>
  )
}

function CountCard({
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
      <p className="text-3xl font-bold tracking-[-0.02em] tabular-nums mb-1">
        {value}
      </p>
      <p className="text-[11px] text-lh-text-mute leading-snug">{sub}</p>
    </Card>
  )
}

function Row({
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
      <dt className="font-mono uppercase tracking-[0.14em] text-[10px] text-lh-text-mute sm:w-32 shrink-0">
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

function ShareButton({ url }: { url: string }) {
  const fullUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${url}` : url
  return (
    <button
      type="button"
      onClick={() => {
        try {
          void navigator.clipboard.writeText(fullUrl)
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
      Copy share URL
    </button>
  )
}
