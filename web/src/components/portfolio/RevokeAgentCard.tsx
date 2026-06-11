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
  // / Disabled when the agent is already revoked.
  disabled?: boolean
}

export function RevokeAgentCard({ profile, disabled }: Props) {
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ digest: string } | null>(null)

  if (!profile.executorAgentId) {
    return (
      <Card className="p-6 md:p-8">
        <h3 className="text-lg font-semibold mb-2 text-lh-text-dim">
          Revoke executor agent
        </h3>
        <p className="text-sm text-lh-text-dim">
          You don't have an executor agent yet. Set up trading from the Telegram
          bot first.
        </p>
      </Card>
    )
  }

  async function revoke() {
    setPending(true)
    setError(null)
    try {
      const built = await apiFetch<SponsorBuildResponse>('/agent/revoke', {
        method: 'POST',
        body: {},
      })
      const exec = await execSponsored(built)
      setSuccess({ digest: exec.digest })
      // Refresh portfolio + agent snapshot.
      void qc.invalidateQueries({ queryKey: ['agent'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
      void qc.invalidateQueries({ queryKey: ['auth'] })
    } catch (e) {
      setError((e as Error).message ?? 'Revoke failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <h3 className="text-lg font-semibold mb-2">Revoke executor agent</h3>
      <p className="text-sm text-lh-text-dim mb-5">
        One-click kill switch. Sets{' '}
        <code className="font-mono">revoked = true</code> on-chain, deregisters
        the TradeCap from your BalanceManager, and anchors the revocation event
        in a single atomic PTB.
      </p>

      <div className="rounded-xl bg-lh-bg/40 border border-lh-line p-4 text-xs space-y-1 mb-5">
        <p className="font-mono uppercase tracking-[0.12em] text-lh-text-mute">
          Atomic PTB
        </p>
        <ol className="font-mono text-lh-text-dim list-decimal pl-5 space-y-0.5">
          <li>executor::revoke</li>
          <li>audit_anchor::record (kind = revocation)</li>
          <li>transfer_to_owner</li>
        </ol>
      </div>

      {success ? (
        <p className="text-sm text-lh-accent">
          Revoked.{' '}
          <a
            href={`${config.links.explorerBase}/tx/${success.digest}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View transaction
          </a>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="inline-flex items-start gap-2 text-xs text-lh-text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              className="mt-0.5 accent-lh-accent"
              disabled={disabled || pending}
            />
            <span>
              I understand revocation is permanent. The TradeCap cannot be
              re-attached; I would need to mint a new ExecutorAgent.
            </span>
          </label>
          <button
            type="button"
            disabled={!confirm || disabled || pending}
            onClick={revoke}
            className={cnm(
              'inline-flex self-start items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold',
              'transition-colors duration-150',
              'focus-visible:outline-2 focus-visible:outline-lh-focus-ring focus-visible:outline-offset-2',
              !confirm || disabled || pending
                ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
                : 'bg-red-500 text-white hover:bg-red-600',
            )}
          >
            {pending ? 'Revoking…' : 'Revoke executor agent'}
          </button>
          {error && (
            <p className="text-xs text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
