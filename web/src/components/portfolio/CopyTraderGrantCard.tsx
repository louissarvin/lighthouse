import { useState } from 'react'

import type { SponsorBuildResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { ApiError, apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { config } from '@/config'

/**
 * Multi-agent SEAL grant — UC4 in LIGHTHOUSE.md §3.2.
 *
 * The user can grant a second agent (e.g. Lighthouse CopyTrader) read access
 * to their `lighthouse:risk-profile` slice. The grant is a sponsored
 * `trader_profile::grant_copy_trader` PTB. SEAL key servers honor it on
 * `fetchKeys`; once the copy-trader has decrypted once, that plaintext is
 * theirs forever (LIGHTHOUSE.md §8.5 gotcha 14 — surfaced as a warning).
 *
 * Revocation is also sponsored; revokes only block FUTURE fetches.
 */
export function CopyTraderGrantCard() {
  const execSponsored = useExecuteSponsored()
  const [address, setAddress] = useState('')
  const [days, setDays] = useState(30)
  const [pending, setPending] = useState<'grant' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<{
    op: 'grant' | 'revoke'
    digest: string
    note?: string
  } | null>(null)

  async function grant() {
    if (!isValidAddress(address)) {
      setError('Enter a valid Sui address (0x… 64 hex).')
      return
    }
    setError(null)
    setLast(null)
    setPending('grant')
    try {
      const validUntilMs = Date.now() + days * 24 * 60 * 60 * 1000
      const sponsored = await apiFetch<SponsorBuildResponse>(
        '/multi-agent/grant-copy-trader',
        {
          method: 'POST',
          body: { copyTraderAddress: address.trim(), validUntilMs },
        },
      )
      await execSponsored(sponsored)
      setLast({
        op: 'grant',
        digest: sponsored.digest,
        note: sponsored.note,
      })
    } catch (e) {
      setError(formatErr(e))
    } finally {
      setPending(null)
    }
  }

  async function revoke() {
    if (!isValidAddress(address)) {
      setError('Enter a valid Sui address (0x… 64 hex).')
      return
    }
    setError(null)
    setLast(null)
    setPending('revoke')
    try {
      const sponsored = await apiFetch<SponsorBuildResponse>(
        '/multi-agent/revoke-copy-trader',
        {
          method: 'POST',
          body: { copyTraderAddress: address.trim() },
        },
      )
      await execSponsored(sponsored)
      setLast({ op: 'revoke', digest: sponsored.digest })
    } catch (e) {
      setError(formatErr(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <div className="mb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
          SEAL · multi-agent access
        </p>
        <h2 className="text-2xl font-bold tracking-[-0.02em] mb-1">
          Share your risk profile
        </h2>
        <p className="text-sm text-lh-text-dim leading-relaxed max-w-xl">
          Grant a second agent (e.g. a copy-trader) read access to your
          encrypted <span className="font-mono">lighthouse:risk-profile</span>{' '}
          slice. The agent's SEAL <span className="font-mono">fetchKeys</span>{' '}
          calls honor the on-chain allowlist; revoking only blocks future
          fetches.
        </p>
      </div>

      <div className="space-y-3 mb-5">
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Copy-trader Sui address (0x…)
          </span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60"
          />
        </label>
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Grant duration · {days} days
          </span>
          <input
            type="range"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full accent-lh-accent"
          />
        </label>
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={revoke}
          disabled={pending !== null || !address.trim()}
          className={cnm(
            'rounded-full border border-lh-line text-sm px-4 py-2',
            'hover:border-red-400/50 hover:text-red-300',
            'disabled:opacity-50 disabled:pointer-events-none',
          )}
        >
          {pending === 'revoke' ? '…' : 'Revoke'}
        </button>
        <button
          type="button"
          onClick={grant}
          disabled={pending !== null || !address.trim()}
          className={cnm(
            'rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-4 py-2',
            'hover:bg-lh-accent-warm transition-colors duration-150',
            'disabled:opacity-50 disabled:pointer-events-none',
          )}
        >
          {pending === 'grant' ? '…' : 'Grant access'}
        </button>
      </div>

      {last && (
        <div className="mt-4 rounded-xl border border-lh-line bg-lh-bg/40 p-3 text-xs">
          <p className="font-mono uppercase tracking-[0.12em] text-emerald-300 mb-1">
            {last.op === 'grant' ? 'Grant executed' : 'Revoke executed'}
          </p>
          <p className="font-mono text-lh-text-dim break-all">
            digest{' '}
            <a
              href={`${config.links.explorerBase}/tx/${last.digest}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lh-accent hover:underline"
            >
              {last.digest.slice(0, 14)}…
            </a>
          </p>
          {last.note && (
            <p className="mt-2 text-lh-text-dim leading-relaxed">{last.note}</p>
          )}
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-300 leading-relaxed">{error}</p>
      )}
    </Card>
  )
}

function isValidAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{1,64}$/.test(s.trim())
}

function formatErr(e: unknown): string {
  if (e instanceof ApiError) {
    return `${e.message}${e.code ? ` (${e.code})` : ''}`
  }
  return (e as Error).message ?? 'request failed'
}
