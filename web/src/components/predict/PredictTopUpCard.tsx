import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { cnm } from '@/utils/style'

const DUSDC_TYPE_TAG =
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC'

interface Props {
  managerId: string | null | undefined
}

export function PredictTopUpCard({ managerId }: Props) {
  const execSponsored = useExecuteSponsored()
  const qc = useQueryClient()
  const [amount, setAmount] = useState('50')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function deposit() {
    if (!managerId) return
    setPending(true)
    setError(null)
    setSuccess(false)
    try {
      const built = await apiFetch<{ digest: string; bytes: string }>(
        '/predict/deposit',
        {
          method: 'POST',
          body: {
            managerObjectId: managerId,
            coinTypeTag: DUSDC_TYPE_TAG,
          },
        },
      )
      await execSponsored(built)
      void qc.invalidateQueries({ queryKey: ['predict', 'pnl'] })
      void qc.invalidateQueries({ queryKey: ['agent', 'balances'] })
      void qc.invalidateQueries({ queryKey: ['agent', 'snapshot'] })
      setSuccess(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const disabled = !managerId || pending

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="none" className="mb-3">
        Top Up DUSDC
      </EyebrowTag>
      <h3 className="text-lg font-semibold mb-1">
        Add funds to your Predict Manager
      </h3>
      <p className="text-sm text-lh-text-dim mb-5">
        Deposit DUSDC from your wallet into your PredictManager to place
        predictions.
      </p>

      <label className="block mb-5">
        <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
          Amount
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            disabled={disabled}
            className={cnm(
              'w-full rounded-xl border border-lh-line bg-lh-bg/60',
              'px-4 py-2.5 text-base font-mono tabular-nums',
              'text-lh-text placeholder:text-lh-text-mute',
              'focus:outline-none focus:border-lh-accent transition-colors',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
            placeholder="50"
          />
          <span className="font-mono text-sm text-lh-text-mute shrink-0">
            DUSDC
          </span>
        </div>
      </label>

      {success ? (
        <p className="text-sm text-lh-accent">
          Deposited! Your balance will update shortly.
        </p>
      ) : (
        <GlowBorderButton
          as="button"
          onClick={deposit}
          size="md"
          className={cnm(
            'w-full',
            disabled && 'opacity-50 pointer-events-none',
          )}
        >
          {pending ? 'Depositing…' : 'Deposit'}
        </GlowBorderButton>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      {!managerId && (
        <p className="mt-3 text-xs text-lh-text-mute">
          Create a PredictManager first to enable deposits.
        </p>
      )}
    </Card>
  )
}
