import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type {
  PredictMarket,
  ProfileMe,
  SponsorBuildResponse,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  profile: ProfileMe
  managerObjectId: string | null
  market: PredictMarket | null
}

const DUSDC_DECIMALS = 6

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

export function MintForm({ profile, managerObjectId, market }: Props) {
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [side, setSide] = useState<'up' | 'down'>('up')
  const [qty, setQty] = useState('10')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!market) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [market])

  if (!market) {
    return (
      <Card className="p-6 md:p-8">
        <h3 className="text-lg font-semibold mb-2">Mint a position</h3>
        <p className="text-sm text-lh-text-dim">
          Pick a market from the list to mint UP / DOWN tokens.
        </p>
      </Card>
    )
  }

  const expiryMs = Number(BigInt(market.expiry_ms))
  const timeLeft = expiryMs - now
  const isExpired = timeLeft <= 0
  const isExpiringSoon = !isExpired && timeLeft < 5 * 60 * 1000

  const canMint =
    !!managerObjectId &&
    !!market.predict_object_id &&
    !!market.oracle_object_id &&
    !!market.quote_type_tag

  async function mint() {
    if (!canMint || !market) return
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      const quantity = BigInt(
        Math.floor(parseFloat(qty || '0') * Math.pow(10, DUSDC_DECIMALS)),
      )
      const built = await apiFetch<SponsorBuildResponse>('/predict/mint', {
        method: 'POST',
        body: {
          predictObjectId: market.predict_object_id,
          managerObjectId,
          oracleObjectId: market.oracle_object_id,
          quoteTypeTag: market.quote_type_tag,
          oracleId: market.oracle_id,
          expiryMs: market.expiry_ms,
          strike: market.strike,
          isUp: side === 'up',
          quantity: quantity.toString(),
        },
      })
      const exec = await execSponsored(built)
      setSuccess(exec.digest)
      void qc.invalidateQueries({ queryKey: ['predict'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <h3 className="text-lg font-semibold mb-1">Mint a position</h3>
      <p className="text-xs text-lh-text-mute mb-5">
        {market.symbol ?? 'Market'} · strike{' '}
        {(Number(BigInt(market.strike)) / 1_000_000_000).toLocaleString(
          'en-US',
          {
            maximumFractionDigits: 4,
          },
        )}
      </p>

      <div
        role="tablist"
        className="grid grid-cols-2 gap-2 mb-5 p-1 rounded-full bg-lh-bg/40 border border-lh-line"
      >
        <button
          type="button"
          role="tab"
          aria-selected={side === 'up'}
          onClick={() => setSide('up')}
          className={cnm(
            'rounded-full py-2 text-sm font-semibold transition-colors',
            side === 'up'
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'text-lh-text-mute hover:text-lh-text',
          )}
        >
          UP
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={side === 'down'}
          onClick={() => setSide('down')}
          className={cnm(
            'rounded-full py-2 text-sm font-semibold transition-colors',
            side === 'down'
              ? 'bg-red-500/15 text-red-400'
              : 'text-lh-text-mute hover:text-lh-text',
          )}
        >
          DOWN
        </button>
      </div>

      <label className="block mb-4">
        <span className="block text-[11px] uppercase tracking-[0.12em] font-mono text-lh-text-mute mb-1.5">
          DUSDC quantity
        </span>
        <input
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
          className={cnm(
            'w-full rounded-xl border border-lh-line bg-lh-bg/60',
            'px-4 py-2.5 text-base font-mono tabular-nums',
            'text-lh-text placeholder:text-lh-text-mute',
            'focus:outline-none focus:border-lh-accent transition-colors',
          )}
          placeholder="10.00"
        />
      </label>

      <div className="mb-4 rounded-xl bg-lh-bg/30 border border-lh-line p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-2">
          Atomic PTB
        </p>
        <ol className="font-mono text-xs text-lh-text-dim list-decimal pl-5 space-y-0.5">
          <li>market_key::new</li>
          <li>predict::mint&lt;DUSDC&gt;</li>
          <li>audit_anchor::record (kind = recommendation)</li>
          <li>audit_anchor::transfer_to_owner</li>
        </ol>
      </div>

      {!canMint && (
        <p className="text-xs text-amber-300 mb-3" role="alert">
          {!managerObjectId
            ? 'Create a PredictManager first using the banner above.'
            : 'This market is missing on-chain IDs (stub). Wait for upstream to come online.'}
        </p>
      )}

      {(isExpiringSoon || isExpired) && (
        <p
          className={cnm(
            'text-xs mb-3',
            isExpired ? 'text-red-400' : 'text-amber-300',
          )}
          role="alert"
        >
          {isExpired
            ? 'Market has expired. Select a new market.'
            : `Market expires in ${formatTimeLeft(timeLeft)} — mints may fail on-chain after this.`}
        </p>
      )}

      {success ? (
        <p className="text-sm text-emerald-400">
          Mint executed.{' '}
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
          onClick={mint}
          disabled={!canMint || pending || isExpired}
          className={cnm(
            'w-full rounded-full py-3 text-sm font-semibold transition-colors',
            !canMint || pending || isExpired
              ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
              : side === 'up'
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : 'bg-red-500 text-white hover:bg-red-600',
          )}
        >
          {pending
            ? 'Minting…'
            : `Mint ${side.toUpperCase()} for ${profile.suiAddress.slice(0, 8)}…`}
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
