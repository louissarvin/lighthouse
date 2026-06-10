import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'

import type { PredictMarket, SponsorBuildResponse } from '@/lib/types'
import { apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Card } from '@/components/ui/Card'
import { OnboardingBanner } from '@/components/ui/OnboardingBanner'
import { MarketList } from '@/components/predict/MarketList'
import { MintForm } from '@/components/predict/MintForm'
import { PositionsList } from '@/components/predict/PositionsList'
import { PredictTopUpCard } from '@/components/predict/PredictTopUpCard'
import { UnclaimedWinsBanner } from '@/components/predict/UnclaimedWinsBanner'
import { requireRiskSetup } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { cnm } from '@/utils/style'
import { config } from '@/config'

export const Route = createFileRoute('/predict')({
  beforeLoad: requireRiskSetup,
  component: PredictPage,
  head: () => ({
    meta: [
      { title: 'Predict · Lighthouse' },
      {
        name: 'description',
        content:
          'DeepBook Predict binary markets with bundled audit anchors. Testnet only.',
      },
    ],
  }),
})

function PredictPage() {
  const { profile, refresh } = useAuth()
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [selected, setSelected] = useState<PredictMarket | null>(null)
  const [onboarding, setOnboarding] = useState(false)
  const [onboardError, setOnboardError] = useState<string | null>(null)
  const [onboardOk, setOnboardOk] = useState<string | null>(null)

  const managerId = profile?.predictManagerId ?? null

  async function createManager() {
    setOnboarding(true)
    setOnboardError(null)
    try {
      const built = await apiFetch<SponsorBuildResponse>('/predict/onboard', {
        method: 'POST',
        body: {},
      })
      const exec = await execSponsored(built)

      // Record the newly-created PredictManager ID back to the DB.
      await apiFetch('/predict/record-manager', {
        method: 'POST',
        body: { txDigest: exec.digest },
      })

      setOnboardOk(exec.digest)
      await refresh()
      void qc.invalidateQueries({ queryKey: ['predict'] })
    } catch (e) {
      setOnboardError((e as Error).message || 'Onboard failed')
    } finally {
      setOnboarding(false)
    }
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <div className="mb-8">
            <EyebrowTag dot className="mb-3">
              DeepBook Predict · Testnet only
            </EyebrowTag>
            <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
              Predict
            </h1>
            <p className="text-lh-text-dim text-base max-w-xl">
              Binary expiry markets composed atomically with audit anchors.
              Mints settle on Sui testnet under the same executor agent that
              powers Trade.
            </p>
          </div>

          <OnboardingBanner className="mb-6" />

          {!managerId && (
            <Card className="p-6 md:p-7 mb-6 border border-amber-500/30 bg-amber-500/5">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold mb-1">
                    Create your PredictManager
                  </h3>
                  <p className="text-sm text-lh-text-dim max-w-xl">
                    A one-time shared object that holds your positions. Signed
                    client-side via zkLogin — no extension needed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={createManager}
                  disabled={onboarding}
                  className={cnm(
                    'rounded-full px-5 py-2.5 text-sm font-semibold transition-colors',
                    onboarding
                      ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
                      : 'bg-lh-accent text-lh-bg hover:bg-lh-accent-warm',
                  )}
                >
                  {onboarding ? 'Creating…' : 'Create PredictManager'}
                </button>
              </div>
              {onboardError && (
                <p className="mt-3 text-xs text-red-400" role="alert">
                  {onboardError}
                </p>
              )}
              {onboardOk && (
                <p className="mt-3 text-xs text-emerald-400">
                  Created.{' '}
                  <a
                    href={`${config.links.explorerBase}/tx/${onboardOk}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    View tx
                  </a>
                </p>
              )}
            </Card>
          )}

          {profile && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
              <div className="space-y-6">
                <UnclaimedWinsBanner managerId={managerId} />
                <MarketList
                  selectedOracleId={selected?.oracle_id ?? null}
                  onSelect={setSelected}
                />
                <PositionsList managerId={managerId} />
                {managerId && <PredictTopUpCard managerId={managerId} />}
              </div>
              <div>
                <MintForm
                  profile={profile}
                  managerObjectId={managerId}
                  market={selected}
                />
              </div>
            </div>
          )}
        </Container>
      </section>
    </main>
  )
}
