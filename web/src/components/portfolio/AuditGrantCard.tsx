import { useState } from 'react'

import type { AuditGrantResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { ApiError, apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { cnm } from '@/utils/style'
import { config } from '@/config'

type Duration = { label: string; ms: number }

const DURATIONS: Array<Duration> = [
  { label: '1h', ms: 60 * 60 * 1_000 },
  { label: '6h', ms: 6 * 60 * 60 * 1_000 },
  { label: '24h', ms: 24 * 60 * 60 * 1_000 },
  { label: '72h', ms: 72 * 60 * 60 * 1_000 },
]

function isValidAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{1,64}$/.test(s.trim())
}

function formatErr(e: unknown): string {
  if (e instanceof ApiError) {
    return `${e.message}${e.code ? ` (${e.code})` : ''}`
  }
  return (e as Error).message
}

export function AuditGrantCard() {
  const execSponsored = useExecuteSponsored()
  const [address, setAddress] = useState('')
  const [durationIdx, setDurationIdx] = useState(2) // default 24h
  const [capId, setCapId] = useState('')
  const [pending, setPending] = useState<'grant' | 'revoke' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<{
    op: 'grant' | 'revoke'
    digest: string
    note?: string
  } | null>(null)

  async function grant() {
    if (!isValidAddress(address)) {
      setError('Enter a valid Sui address (0x… up to 64 hex).')
      return
    }
    setError(null)
    setLast(null)
    setPending('grant')
    try {
      const validUntilMs =
        Date.now() + (DURATIONS[durationIdx]?.ms ?? 86_400_000)
      const sponsored = await apiFetch<AuditGrantResponse>(
        '/multi-agent/grant-audit',
        {
          method: 'POST',
          body: { auditorAddress: address.trim(), validUntilMs },
        },
      )
      await execSponsored(sponsored)
      setLast({ op: 'grant', digest: sponsored.digest, note: sponsored.note })
    } catch (e) {
      setError(formatErr(e))
    } finally {
      setPending(null)
    }
  }

  async function revokeCap() {
    if (!capId.trim()) {
      setError('Enter a Cap Object ID to revoke.')
      return
    }
    setError(null)
    setLast(null)
    setPending('revoke')
    try {
      const sponsored = await apiFetch<{ digest: string; bytes: string }>(
        '/multi-agent/revoke-audit',
        {
          method: 'POST',
          body: { capId: capId.trim() },
        },
      )
      await execSponsored(sponsored)
      setLast({ op: 'revoke', digest: sponsored.digest })
      setCapId('')
    } catch (e) {
      setError(formatErr(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="none" className="mb-3">
        Audit Access
      </EyebrowTag>
      <h2 className="text-2xl font-bold tracking-[-0.02em] mb-1">
        Grant Audit Access
      </h2>
      <p className="text-sm text-lh-text-dim leading-relaxed max-w-xl mb-5">
        Issue a time-limited AuditCap NFT to an auditor address. They can read
        all your encrypted memory slices until the cap expires.
      </p>

      {/* Amber warning */}
      <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300 leading-relaxed">
        Past decryption cannot be retracted. Any data already decrypted remains
        with the auditor. Use short validity windows.
      </div>

      {/* Grant section */}
      <div className="space-y-3 mb-5">
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Auditor Sui address (0x…)
          </span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60 transition-colors"
          />
        </label>

        <div>
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Validity window · {DURATIONS[durationIdx]?.label}
          </span>
          <div className="flex gap-2">
            {DURATIONS.map((d, i) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDurationIdx(i)}
                className={cnm(
                  'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                  i === durationIdx
                    ? 'bg-lh-accent/10 text-lh-accent border border-lh-accent/30'
                    : 'border border-lh-line text-lh-text-mute hover:text-lh-text',
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end mb-8">
        <GlowBorderButton
          as="button"
          onClick={grant}
          size="md"
          className={cnm(
            pending !== null || !address.trim()
              ? 'opacity-50 pointer-events-none'
              : '',
          )}
        >
          {pending === 'grant' ? 'Granting…' : 'Grant Audit Cap'}
        </GlowBorderButton>
      </div>

      {/* Revoke section */}
      <div className="border-t border-lh-line pt-5 space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
          Revoke by Cap ID
        </p>
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Cap Object ID
          </span>
          <input
            value={capId}
            onChange={(e) => setCapId(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60 transition-colors"
          />
        </label>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={revokeCap}
            disabled={pending !== null || !capId.trim()}
            className={cnm(
              'rounded-full border border-lh-line text-sm px-4 py-2',
              'hover:border-red-400/50 hover:text-red-300 transition-colors',
              'disabled:opacity-50 disabled:pointer-events-none',
            )}
          >
            {pending === 'revoke' ? '…' : 'Revoke'}
          </button>
        </div>
      </div>

      {/* Result */}
      {last && (
        <div className="mt-4 rounded-xl border border-lh-line bg-lh-bg/40 p-3 text-xs">
          <p className="font-mono uppercase tracking-[0.12em] text-emerald-300 mb-1">
            {last.op === 'grant' ? 'AuditCap granted' : 'Cap revoked'}
          </p>
          <p className="font-mono text-lh-text-dim break-all">
            Tx{' '}
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
        <p className="mt-4 text-sm text-red-300 leading-relaxed" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}
