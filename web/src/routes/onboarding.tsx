/**
 * /onboarding — first-run status & recovery page.
 *
 * Architecture context (LIGHTHOUSE.md §3.2 UC1 + backend SetupTrading.ts):
 * the full trading-state bootstrap (BalanceManager + ExecutorAgent + initial
 * SUI drip) runs INSIDE the OAuth callback at the moment a user signs in,
 * because it needs a fresh Google JWT + the ephemeral zkLogin keys that are
 * scoped to that one nonce. There is no way to retry it from a long-lived
 * session — by the time the user is browsing the SPA, the JWT has expired
 * and the ephemeral keypair is gone.
 *
 * This page therefore does two things:
 *  1. Reflects the current setup state honestly (BalanceManager / Executor /
 *     MemWal account / SuiNS / Walrus Site) so the user can see exactly what
 *     bootstrapped successfully.
 *  2. Offers a "re-authenticate to retry setup" CTA when anything is
 *     missing — the new OAuth callback will redo the setup transaction.
 *
 * It is intentionally NOT auto-imposed: /trade, /coach, /predict do their
 * own readiness checks. /onboarding is the diagnostic surface.
 */

import { Link, createFileRoute, useNavigate  } from '@tanstack/react-router'
import { AlertCircle, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react'

import type { ProfileMe } from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAuth } from '@/hooks/useAuth'
import { requireAuth } from '@/lib/requireAuth'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: requireAuth,
  component: OnboardingPage,
  head: () => ({
    meta: [
      { title: 'Onboarding · Lighthouse' },
      {
        name: 'description',
        content:
          'Status of your Lighthouse trading bootstrap: BalanceManager, Executor agent, MemWal, SuiNS.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

interface StepStatus {
  // / Stable id for keying.
  id: string
  // / Short verb-phrase label ("BalanceManager created").
  label: string
  // / 1-sentence explanation rendered under the label.
  description: string
  // / true → green checkmark; false → amber alert.
  done: boolean
  // / On-chain object id (or null when N/A) to show under the row.
  detail?: string | null
}

function buildSteps(profile: ProfileMe | null): Array<StepStatus> {
  if (!profile) return []
  return [
    {
      id: 'profile',
      label: 'TraderProfile minted',
      description:
        'Your zkLogin address now owns an on-chain TraderProfile shared object.',
      done: !!profile.profileObjectId,
      detail: profile.profileObjectId,
    },
    {
      id: 'balance-manager',
      label: 'BalanceManager created',
      description:
        'DeepBook v3 balance manager that lets the executor route limit orders without holding your funds.',
      done: !!profile.balanceManagerId,
      detail: profile.balanceManagerId,
    },
    {
      id: 'executor',
      label: 'Executor agent provisioned',
      description:
        'Server-side agent with bounded notional + per-trade caps, revocable from /portfolio.',
      done: !!profile.executorAgentId,
      detail: profile.executorAgentId,
    },
    {
      id: 'memwal',
      label: 'MemWal account active',
      description:
        'Cross-session encrypted memory on Walrus. Required for the coach to learn across chats.',
      done: !!profile.memwalAccountId,
      detail: profile.memwalAccountId,
    },
    {
      id: 'suins',
      label: 'SuiNS apex bound (optional)',
      description:
        'Bind your .sui name so other users can share /u/<name> with your weekly tearsheet.',
      done: !!profile.suinsName,
      detail: profile.suinsName ?? null,
    },
  ]
}

function shortId(id: string | null | undefined): string {
  if (!id) return ''
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

function OnboardingPage() {
  const { profile, isLoading, refresh } = useAuth()
  const navigate = useNavigate()

  const steps = buildSteps(profile)
  const required = steps.filter((s) => s.id !== 'suins')
  const requiredDone = required.every((s) => s.done)
  const allDone = steps.every((s) => s.done)
  const completedCount = required.filter((s) => s.done).length

  async function handleRefresh() {
    await refresh()
  }

  function handleReauth() {
    // Carry the user back here after auth so they see the new state.
    navigate({ to: '/auth', search: { next: '/onboarding' } as never })
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      {profile ? <AppNav /> : <PillNav />}
      <section className="pt-24 pb-20 md:pt-32 md:pb-28">
        <Container>
          <div className="max-w-3xl mx-auto">
            <EyebrowTag prefix="dot" className="mb-5">
              Onboarding status
            </EyebrowTag>
            <h1 className="text-4xl md:text-5xl font-bold tracking-[-0.03em] mb-3">
              {requiredDone ? "You're ready to trade" : 'Finishing your setup'}
            </h1>
            <p className="text-lh-text-dim text-base leading-relaxed mb-10 max-w-xl">
              Sign-in provisions a Sui address, a DeepBook BalanceManager, an
              Executor agent, and a MemWal account in one atomic PTB. Below is
              the real-time state of that bootstrap.
            </p>

            {isLoading && (
              <Card className="p-8">
                <div className="space-y-3">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </Card>
            )}

            {!isLoading && profile && (
              <>
                <Card className="mb-6 p-6 md:p-8">
                  <div className="flex items-baseline justify-between mb-5">
                    <h2 className="text-lg font-semibold">Setup checklist</h2>
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute">
                      {completedCount}/{required.length} required
                    </span>
                  </div>
                  <ol className="space-y-5">
                    {steps.map((step) => (
                      <li key={step.id} className="flex items-start gap-4">
                        <div className="shrink-0 mt-0.5">
                          {step.done ? (
                            <CheckCircle2
                              size={20}
                              strokeWidth={1.5}
                              className="text-emerald-400"
                              aria-label="complete"
                            />
                          ) : (
                            <AlertCircle
                              size={20}
                              strokeWidth={1.5}
                              className={
                                step.id === 'suins'
                                  ? 'text-lh-text-mute'
                                  : 'text-amber-400'
                              }
                              aria-label={
                                step.id === 'suins' ? 'not set' : 'incomplete'
                              }
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className={cnm(
                              'text-sm font-semibold mb-1',
                              step.done ? 'text-lh-text' : 'text-lh-text-dim',
                            )}
                          >
                            {step.label}
                          </p>
                          <p className="text-sm text-lh-text-dim leading-relaxed mb-1">
                            {step.description}
                          </p>
                          {step.detail && (
                            <p className="font-mono text-[11px] text-lh-text-mute break-all">
                              {shortId(step.detail)}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </Card>

                {requiredDone ? (
                  <ReadyPanel onRefresh={handleRefresh} allDone={allDone} />
                ) : (
                  <IncompletePanel onReauth={handleReauth} />
                )}

                <Card className="mt-6 p-6 md:p-8">
                  <h2 className="text-lg font-semibold mb-4">
                    Quick reference
                  </h2>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                    <Row label="Sui address" value={profile.suiAddress} />
                    <Row
                      label="TraderProfile"
                      value={profile.profileObjectId}
                    />
                    {profile.balanceManagerId && (
                      <Row
                        label="BalanceManager"
                        value={profile.balanceManagerId}
                      />
                    )}
                    {profile.executorAgentId && (
                      <Row
                        label="Executor agent"
                        value={profile.executorAgentId}
                      />
                    )}
                    {profile.memwalAccountId && (
                      <Row
                        label="MemWal account"
                        value={profile.memwalAccountId}
                      />
                    )}
                    {profile.depositCapId && (
                      <Row label="Deposit cap" value={profile.depositCapId} />
                    )}
                  </dl>
                </Card>
              </>
            )}
          </div>
        </Container>
      </section>
    </main>
  )
}

function ReadyPanel({
  onRefresh,
  allDone,
}: {
  onRefresh: () => Promise<void>
  allDone: boolean
}) {
  return (
    <Card className="p-6 md:p-8 border border-emerald-500/30 bg-emerald-500/[0.03]">
      <div className="flex items-start gap-4 mb-5">
        <CheckCircle2
          size={28}
          strokeWidth={1.5}
          className="text-emerald-400 shrink-0 mt-0.5"
        />
        <div>
          <h2 className="text-lg font-semibold mb-1.5">All set</h2>
          <p className="text-sm text-lh-text-dim leading-relaxed">
            Your trading state is live on testnet.{' '}
            {allDone
              ? 'Optional SuiNS binding is also complete — your public profile at /u/<name> is shareable.'
              : 'SuiNS binding is optional; complete it from /portfolio when you have a .sui name.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          to="/coach"
          className="inline-flex items-center gap-2 rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-5 py-2.5 hover:bg-lh-accent/90 transition-colors"
        >
          Talk to the coach
          <ArrowRight size={14} strokeWidth={2} />
        </Link>
        <Link
          to="/trade"
          className="inline-flex items-center gap-2 rounded-full border border-lh-line text-lh-text font-semibold text-sm px-5 py-2.5 hover:border-lh-accent/50 transition-colors"
        >
          Open trading desk
        </Link>
        <Link
          to="/predict"
          className="inline-flex items-center gap-2 rounded-full border border-lh-line text-lh-text font-semibold text-sm px-5 py-2.5 hover:border-lh-accent/50 transition-colors"
        >
          Predict markets
        </Link>
        <Link
          to="/portfolio"
          className="inline-flex items-center gap-2 rounded-full border border-lh-line text-lh-text font-semibold text-sm px-5 py-2.5 hover:border-lh-accent/50 transition-colors"
        >
          Portfolio
        </Link>
        <button
          type="button"
          onClick={() => {
            void onRefresh()
          }}
          className="inline-flex items-center gap-2 rounded-full text-lh-text-dim font-medium text-sm px-3 py-2.5 hover:text-lh-accent transition-colors"
        >
          <RefreshCw size={13} strokeWidth={1.8} />
          Refresh
        </button>
      </div>
    </Card>
  )
}

function IncompletePanel({ onReauth }: { onReauth: () => void }) {
  return (
    <Card className="p-6 md:p-8 border border-amber-500/30 bg-amber-500/[0.03]">
      <div className="flex items-start gap-4 mb-5">
        <AlertCircle
          size={28}
          strokeWidth={1.5}
          className="text-amber-400 shrink-0 mt-0.5"
        />
        <div>
          <h2 className="text-lg font-semibold mb-1.5">
            Setup didn't fully complete
          </h2>
          <p className="text-sm text-lh-text-dim leading-relaxed">
            Sign-in runs a sponsored, atomic bootstrap PTB. If part of it
            reverted (RPC timeout, gas budget, contention), the safest fix is to
            sign in again — the OAuth callback redoes the setup with a fresh JWT
            and ephemeral keys.{' '}
            <span className="text-lh-text-mute">
              No extra signatures are required from you; Enoki sponsors gas.
            </span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onReauth}
          className="inline-flex items-center gap-2 rounded-full bg-amber-500 text-lh-bg font-semibold text-sm px-5 py-2.5 hover:bg-amber-400 transition-colors"
        >
          Re-authenticate to retry setup
          <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute self-baseline">
        {label}
      </dt>
      <dd className="font-mono text-xs text-lh-text-dim break-all">{value}</dd>
    </>
  )
}
