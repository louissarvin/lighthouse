import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import type { ProfileMe, SponsorBuildResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { config } from '@/config'
import { ApiError, apiFetch } from '@/lib/api'
import { useExecuteSponsored } from '@/lib/sponsored'
import { suiscanObjectUrl } from '@/utils/format'

interface Props {
  profile: ProfileMe
}

/**
 * SuiNS bind + Walrus Site metadata writer.
 *
 * Flow:
 *   1. User buys their `.sui` name out-of-band (suins.io). They paste the
 *      SuinsRegistration NFT id + chosen apex SLD here.
 *   2. POST /suins/record-nft-id binds it to their trader profile so the
 *      backend can sponsor metadata writes later without re-asking.
 *   3. (Optional, post Walrus Sites deploy) POST /suins/set-walrus-site-id
 *      pushes the Site object id onto the .sui registration as the
 *      `walrus_site_id` metadata field — that's what makes
 *      `https://lighthouse.wal.app/u/<name>` resolve via the SuiNS portal.
 */
export function SuiNSBindCard({ profile }: Props) {
  const qc = useQueryClient()
  const execSponsored = useExecuteSponsored()
  const [name, setName] = useState('')
  const [nftId, setNftId] = useState('')
  const [siteObjectId, setSiteObjectId] = useState('')
  const [pending, setPending] = useState<'bind' | 'meta' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  async function bind() {
    if (!name.trim() || !nftId.trim()) {
      setError(
        'Both the .sui name and the SuinsRegistration NFT id are required.',
      )
      return
    }
    setError(null)
    setStatus(null)
    setPending('bind')
    try {
      await apiFetch('/suins/record-nft-id', {
        method: 'POST',
        body: { suinsName: name.trim(), suinsNftId: nftId.trim() },
      })
      setStatus(`Bound ${name.trim()} to your profile.`)
      await qc.invalidateQueries({ queryKey: ['auth', 'profile'] })
    } catch (e) {
      setError(formatErr(e))
    } finally {
      setPending(null)
    }
  }

  async function setMeta() {
    if (!nftId.trim() || !siteObjectId.trim()) {
      setError('Both the NFT id and the Walrus Site object id are required.')
      return
    }
    setError(null)
    setStatus(null)
    setPending('meta')
    try {
      const sponsored = await apiFetch<SponsorBuildResponse>(
        '/suins/set-walrus-site-id',
        {
          method: 'POST',
          body: { nftId: nftId.trim(), siteObjectId: siteObjectId.trim() },
        },
      )
      const exec = await execSponsored(sponsored)
      setStatus(
        `Walrus site id set. Tx ${exec.digest.slice(0, 14)}… resolves on-chain in ~3s.`,
      )
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
          SuiNS · Walrus Sites
        </p>
        <h2 className="text-2xl font-bold tracking-[-0.02em] mb-1">
          Bind your .sui name
        </h2>
        <p className="text-sm text-lh-text-dim leading-relaxed max-w-xl">
          Resolve your trader profile via a friendly{' '}
          <span className="font-mono">alice.sui</span> name. After we deploy the
          Walrus Site, push the Site object id here to surface your public
          tearsheets at{' '}
          <span className="font-mono">
            {config.links.walAppUrl}/u/alice.sui
          </span>
          .
        </p>
      </div>

      {/* Current binding */}
      <div className="mb-5 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field
          label="Bound name"
          value={profile.suinsName ?? 'not set'}
          mono={!!profile.suinsName}
        />
        <div className="rounded-xl border border-lh-line bg-lh-bg/40 px-3 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-0.5">
            Trader profile
          </p>
          <a
            href={suiscanObjectUrl(profile.profileObjectId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-lh-text hover:text-lh-accent transition-colors break-all"
          >
            {profile.profileObjectId.slice(0, 12)}…
            <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </div>
      </div>

      {profile.suinsName && <ShareLink suinsName={profile.suinsName} />}

      <div className="space-y-3 mb-5">
        <Labeled label=".sui name (e.g. alice.sui)">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="alice.sui"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm focus:outline-none focus:border-lh-accent/60"
          />
        </Labeled>
        <Labeled label="SuinsRegistration NFT id (0x…)">
          <input
            value={nftId}
            onChange={(e) => setNftId(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60"
          />
        </Labeled>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={bind}
            disabled={pending !== null || !name.trim() || !nftId.trim()}
            className={cnm(
              'rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-4 py-2',
              'hover:bg-lh-accent-warm transition-colors duration-150',
              'disabled:opacity-50 disabled:pointer-events-none',
            )}
          >
            {pending === 'bind' ? '…' : 'Bind name'}
          </button>
        </div>
      </div>

      <div className="space-y-3 border-t border-lh-line pt-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute">
          Walrus Site metadata (optional)
        </p>
        <Labeled label="Walrus Site object id (0x…)">
          <input
            value={siteObjectId}
            onChange={(e) => setSiteObjectId(e.target.value)}
            placeholder="0x…"
            className="w-full rounded-xl border border-lh-line bg-lh-bg/60 px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60"
          />
        </Labeled>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={setMeta}
            disabled={pending !== null || !nftId.trim() || !siteObjectId.trim()}
            className={cnm(
              'rounded-full border border-lh-line text-sm px-4 py-2 hover:border-lh-accent/50',
              'disabled:opacity-50 disabled:pointer-events-none',
            )}
          >
            {pending === 'meta' ? '…' : 'Set Walrus site'}
          </button>
        </div>
        <p className="text-[11px] text-lh-text-mute leading-relaxed">
          Signs and executes a sponsored PTB. The metadata write resolves
          on-chain in ~3s.
        </p>
      </div>

      {status && (
        <p className="mt-4 text-sm text-emerald-300 leading-relaxed">
          {status}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-300 leading-relaxed">{error}</p>
      )}
    </Card>
  )
}

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-xl border border-lh-line bg-lh-bg/40 px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-0.5">
        {label}
      </p>
      <p
        className={
          mono
            ? 'font-mono text-xs text-lh-text break-all'
            : 'text-sm text-lh-text'
        }
      >
        {value}
      </p>
    </div>
  )
}

function Labeled({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
        {label}
      </span>
      {children}
    </label>
  )
}

function ShareLink({ suinsName }: { suinsName: string }) {
  // The /u/:name route lives inside the SPA and works with both .sui and
  // non-suffixed forms. Backend resolution is identical.
  const path = `/u/${suinsName}`
  const fullUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${path}` : path

  return (
    <div className="mb-5 rounded-2xl border border-lh-accent/30 bg-lh-accent/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      <div className="flex-1 min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-accent mb-1">
          Share your profile
        </p>
        <a
          href={path}
          className="font-mono text-xs text-lh-text hover:text-lh-accent break-all"
        >
          {fullUrl}
        </a>
      </div>
      <button
        type="button"
        onClick={() => {
          try {
            void navigator.clipboard.writeText(fullUrl)
          } catch {
            // ignore
          }
        }}
        className={cnm(
          'shrink-0 inline-flex items-center gap-1.5 rounded-full',
          'bg-lh-accent text-lh-bg font-semibold text-[11px] font-mono uppercase tracking-[0.14em]',
          'px-3 py-1.5 hover:bg-lh-accent/90 transition-colors',
        )}
      >
        Copy
      </button>
    </div>
  )
}

function formatErr(e: unknown): string {
  if (e instanceof ApiError) {
    return `${e.message}${e.code ? ` (${e.code})` : ''}`
  }
  return (e as Error).message ?? 'request failed'
}
