import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import type { AgentSnapshotResponse, ProfileMe } from '@/lib/types'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Skeleton } from '@/components/ui/Skeleton'
import { ProfileCard } from '@/components/portfolio/ProfileCard'
import { AnchorTimeline } from '@/components/portfolio/AnchorTimeline'
import { TradesTable } from '@/components/portfolio/TradesTable'
import { TearsheetList } from '@/components/portfolio/TearsheetList'
import { RevokeAgentCard } from '@/components/portfolio/RevokeAgentCard'
import { MemWalBootstrapCard } from '@/components/portfolio/MemWalBootstrapCard'
import { MemWalExplorer } from '@/components/portfolio/MemWalExplorer'
import { SuiNSBindCard } from '@/components/portfolio/SuiNSBindCard'
import { CopyTraderGrantCard } from '@/components/portfolio/CopyTraderGrantCard'
import { MessagingCard } from '@/components/portfolio/MessagingCard'
import { BalancesCard } from '@/components/portfolio/BalancesCard'
import { BudgetCard } from '@/components/portfolio/BudgetCard'
import { DepositCard } from '@/components/portfolio/DepositCard'
import { RiskProfileCard } from '@/components/portfolio/RiskProfileCard'
import { PnLCard } from '@/components/predict/PnLCard'
import { AnchorNoteCard } from '@/components/portfolio/AnchorNoteCard'
import { AuditGrantCard } from '@/components/portfolio/AuditGrantCard'
import { NotificationsCard } from '@/components/portfolio/NotificationsCard'
import { apiFetch } from '@/lib/api'
import { requireAuth } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'

export const Route = createFileRoute('/portfolio')({
  beforeLoad: requireAuth,
  component: PortfolioPage,
  head: () => ({
    meta: [
      { title: 'Portfolio · Lighthouse' },
      {
        name: 'description',
        content:
          'Your TraderProfile, executor agent budget, on-chain audit anchors, and weekly tearsheets.',
      },
    ],
  }),
})

function PortfolioPage() {
  const { profile, isLoading } = useAuth()

  // Cached query so RevokeAgentCard + ProfileCard share a single read.
  const { data: agentResp } = useQuery<AgentSnapshotResponse>({
    queryKey: ['agent', 'snapshot', profile?.suiAddress ?? ''],
    queryFn: () => apiFetch<AgentSnapshotResponse>('/agent/snapshot'),
    enabled: !!profile,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <EyebrowTag dot className="mb-4">
            On-chain account
          </EyebrowTag>
          <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
            Portfolio
          </h1>
          <p className="text-lh-text-dim text-base mb-10 max-w-xl">
            Every receipt the bot and the web mint for you, indexed in real
            time. Anchors live on Sui; rationale blobs live on Walrus.
          </p>

          {isLoading || !profile ? (
            <PortfolioSkeleton />
          ) : (
            <ResolvedProfile profile={profile} agent={agentResp ?? null} />
          )}
        </Container>
      </section>
    </main>
  )
}

function ResolvedProfile({
  profile,
  agent,
}: {
  profile: ProfileMe
  agent: AgentSnapshotResponse | null
}) {
  return (
    <div className="space-y-8">
      <ProfileCard profile={profile} />

      <NotificationsCard />

      <DepositCard profile={profile} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BalancesCard />
        <BudgetCard />
      </div>

      {/* Bootstrap MemWal if not yet set up */}
      {!profile.memwalAccountId && <MemWalBootstrapCard profile={profile} />}

      {/* Walrus-backed memory explorer — single card spans full width because
          it carries the recall form + namespace catalog. */}
      <MemWalExplorer />

      <PnLCard />

      <RiskProfileCard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <AnchorTimeline filterAddress={profile.suiAddress} />
        <TradesTable filterAddress={profile.suiAddress} />
      </div>

      <AnchorNoteCard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TearsheetList suiAddress={profile.suiAddress} />
        <RevokeAgentCard
          profile={profile}
          disabled={agent?.snapshot?.revoked ?? false}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SuiNSBindCard profile={profile} />
        <MessagingCard profile={profile} />
      </div>

      <CopyTraderGrantCard />

      <AuditGrantCard />
    </div>
  )
}

function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[160px] w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-[280px]" />
        <Skeleton className="h-[280px]" />
      </div>
    </div>
  )
}
