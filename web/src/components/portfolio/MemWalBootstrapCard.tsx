import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ProfileMe, SponsorBuildResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  profile: ProfileMe
}

export function MemWalBootstrapCard({ profile: _profile }: Props) {
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const pending = step !== 0

  async function bootstrap() {
    setError(null)
    setSuccess(null)
    setStep(1)
    try {
      // Phase 1: sign + execute client-side
      const phase1 = await apiFetch<SponsorBuildResponse>('/memwal/begin', {
        method: 'POST',
        body: {},
      })
      const exec1 = await execSponsored(phase1)

      // Phase 2: register delegate key
      setStep(2)
      const phase2 = await apiFetch<SponsorBuildResponse>('/memwal/step2', {
        method: 'POST',
        body: { executedDigest: exec1.digest },
      })
      const exec2 = await execSponsored(phase2)

      setSuccess(exec2.digest)
      void qc.invalidateQueries({ queryKey: ['memwal', 'namespaces'] })
      void qc.invalidateQueries({ queryKey: ['profile'] })
      void qc.invalidateQueries({ queryKey: ['auth', 'profile-me'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bootstrap failed')
    } finally {
      setStep(0)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-3">
        MemWal · Two-phase bootstrap
      </p>
      <h3 className="text-lg font-semibold mb-2">
        Set up your encrypted memory
      </h3>
      <p className="text-sm text-lh-text-dim mb-5 max-w-prose">
        Coach needs MemWal to recall your goals, risk profile, and past lessons.
        Two sponsored transactions bootstrap your account and register the
        backend's delegate key.
      </p>

      <div className="mb-5 rounded-xl bg-lh-bg/30 border border-lh-line p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-2">
          Atomic PTBs
        </p>
        <div className="space-y-2">
          <div>
            <p className="font-mono text-[11px] text-lh-text-dim mb-1">
              Phase 1
            </p>
            <ol className="font-mono text-xs text-lh-text-dim list-decimal pl-5 space-y-0.5">
              <li>memwal::create_account</li>
              <li>Transfer account object to you</li>
            </ol>
          </div>
          <div>
            <p className="font-mono text-[11px] text-lh-text-dim mb-1">
              Phase 2
            </p>
            <ol
              className="font-mono text-xs text-lh-text-dim list-decimal pl-5 space-y-0.5"
              start={3}
            >
              <li>memwal::add_delegate_key (coach backend key)</li>
            </ol>
          </div>
        </div>
      </div>

      {success ? (
        <p className="text-sm text-emerald-400">
          MemWal bootstrapped.{' '}
          <a
            href={`${config.links.explorerBase}/tx/${success}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View tx
          </a>
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void bootstrap()}
          disabled={pending}
          className={cnm(
            'w-full rounded-full py-3 text-sm font-semibold transition-colors',
            'bg-lh-accent text-lh-bg',
            'hover:bg-lh-accent-warm',
            pending && 'opacity-50 cursor-not-allowed',
          )}
        >
          {step === 0 && 'Bootstrap MemWal'}
          {step === 1 && 'Bootstrapping… (1/2)'}
          {step === 2 && 'Bootstrapping… (2/2)'}
        </button>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}
