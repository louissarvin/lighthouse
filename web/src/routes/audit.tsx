import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import {
  useCurrentAccount,
  useSignPersonalMessage,
  useSuiClient,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'

import type { AuditCap, AuditCapsResponse } from '@/lib/types'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { requireAuth } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { config } from '@/config'
import { cnm } from '@/utils/style'
import { walrusBlobUrl } from '@/lib/walrus'
import { getSealClient, SessionKey } from '@/lib/seal'

// TODO: wire up VITE_LIGHTHOUSE_PACKAGE_ID once backend exposes it.
// For now we read from the env. If unset, SEAL decrypt falls back gracefully.
const LIGHTHOUSE_PACKAGE_ID =
  (import.meta.env.VITE_LIGHTHOUSE_PACKAGE_ID as string | undefined) ?? ''

export const Route = createFileRoute('/audit')({
  beforeLoad: requireAuth,
  component: AuditInboxPage,
  head: () => ({
    meta: [
      { title: 'Auditor Inbox · Lighthouse' },
      { name: 'robots', content: 'noindex' },
      {
        name: 'description',
        content: 'AuditCaps granted to your address. SEAL-gated decrypt.',
      },
    ],
  }),
})

function relTime(ms: number): string {
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const d = Math.floor(abs / (24 * 60 * 60 * 1000))
  const h = Math.floor(abs / (60 * 60 * 1000))
  const m = Math.floor(abs / 60_000)
  if (diff < 0) return 'Expired'
  if (d > 0) return `${d}d left`
  if (h > 0) return `${h}h left`
  return `${m}m left`
}

function truncateId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

function AuditInboxPage() {
  const { profile } = useAuth()
  const myAddress = profile?.suiAddress ?? ''

  const { data, isLoading, isError } = useQuery<AuditCapsResponse>({
    queryKey: ['audit', 'caps', myAddress],
    queryFn: () =>
      apiFetch<AuditCapsResponse>(`/audit/caps?address=${encodeURIComponent(myAddress)}`),
    enabled: !!myAddress,
    staleTime: 30_000,
  })

  const caps = data?.caps ?? []

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <div className="max-w-3xl mx-auto">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
              SEAL · audit access
            </p>
            <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
              Auditor Inbox
            </h1>
            <p className="text-lh-text-dim text-base mb-2 max-w-xl">
              AuditCaps granted to your address. Each cap lets you request a
              SEAL-gated decrypt of the trader's encrypted memory blobs.
            </p>
            {myAddress && (
              <p className="font-mono text-xs text-lh-text-mute mb-10 break-all">
                Your address:{' '}
                <a
                  href={`${config.links.explorerBase}/account/${myAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lh-accent hover:underline"
                >
                  {myAddress}
                </a>
              </p>
            )}

            {isLoading && (
              <div className="space-y-4">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            )}

            {isError && (
              <Card className="p-6 text-center">
                <p className="text-sm text-lh-text-dim">
                  Failed to load AuditCaps. The audit endpoint may not be
                  available yet.
                </p>
              </Card>
            )}

            {data?.unavailable && (
              <Card className="p-6 text-center">
                <p className="text-sm text-lh-text-dim">
                  Audit cap listing is pending backend wire-up
                  {data.reason ? `: ${data.reason}` : ''}.
                </p>
              </Card>
            )}

            {!isLoading && !isError && !data?.unavailable && caps.length === 0 && (
              <Card className="p-8 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-3">
                  No grants yet
                </p>
                <p className="text-sm text-lh-text-dim leading-relaxed max-w-sm mx-auto">
                  No audit grants yet. Ask a Lighthouse trader to grant you an
                  AuditCap via their portfolio.
                </p>
              </Card>
            )}

            {caps.length > 0 && (
              <div className="space-y-4">
                {caps.map((cap) => (
                  <CapCard key={cap.capId} cap={cap} auditorAddress={myAddress} />
                ))}
              </div>
            )}
          </div>
        </Container>
      </section>
    </main>
  )
}

function CapCard({ cap, auditorAddress }: { cap: AuditCap; auditorAddress: string }) {
  const [blobId, setBlobId] = useState('')
  const [decrypting, setDecrypting] = useState(false)
  const [decryptResult, setDecryptResult] = useState<string | null>(null)
  const [decryptError, setDecryptError] = useState<string | null>(null)

  const suiClient = useSuiClient()
  const account = useCurrentAccount()
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage()

  const isValid = cap.validUntilMs > Date.now()
  const timeLabel = relTime(cap.validUntilMs)

  const canDecrypt = !!(
    LIGHTHOUSE_PACKAGE_ID &&
    isValid &&
    blobId.trim() &&
    auditorAddress &&
    account
  )

  async function decryptViaSeal() {
    if (!canDecrypt || decrypting) return
    setDecrypting(true)
    setDecryptResult(null)
    setDecryptError(null)

    try {
      // 1. Fetch the encrypted bytes from Walrus.
      const url = walrusBlobUrl(blobId.trim())
      if (!url) throw new Error('Invalid blob ID')
      const blobRes = await fetch(url)
      if (!blobRes.ok) throw new Error(`Walrus fetch failed: ${blobRes.status}`)
      const encryptedBytes = new Uint8Array(await blobRes.arrayBuffer())

      // 2. Create a SEAL session key for this auditor + package.
      const sessionKey = await SessionKey.create({
        address: auditorAddress,
        packageId: LIGHTHOUSE_PACKAGE_ID,
        ttlMin: 30,
        suiClient,
      })

      // 3. Ask the user to sign the session key personal message.
      const personalMessage = sessionKey.getPersonalMessage()
      const { signature } = await signPersonalMessage({
        message: personalMessage,
        account: account!,
      })
      await sessionKey.setPersonalMessageSignature(signature)

      // 4. Build the seal_approve_audit PTB.
      //    cap.profileObjectId = the TraderProfile object the cap gates access to.
      const tx = new Transaction()
      tx.moveCall({
        target: `${LIGHTHOUSE_PACKAGE_ID}::trader_profile::seal_approve_audit`,
        arguments: [
          tx.object(blobId.trim()),
          tx.object(cap.profileObjectId),
          tx.object(cap.capId),
          tx.object('0x6'), // Clock
        ],
      })
      const txBytes = await tx.build({ client: suiClient })

      // 5. Decrypt via SEAL key servers.
      const sealClient = getSealClient(suiClient)
      const plaintext = await sealClient.decrypt({
        data: encryptedBytes,
        sessionKey,
        txBytes,
      })

      const decoded = new TextDecoder().decode(plaintext)
      setDecryptResult(decoded)
    } catch (e) {
      const msg = (e as Error).message ?? 'Decrypt failed'
      setDecryptError(msg)
    } finally {
      setDecrypting(false)
    }
  }

  async function decryptFallback() {
    if (!blobId.trim() || decrypting) return
    setDecrypting(true)
    setDecryptResult(null)
    setDecryptError(null)
    try {
      // TODO: Remove this fallback once SEAL key servers are reachable and
      // LIGHTHOUSE_PACKAGE_ID is configured. Currently the backend returns
      // {unavailable: true} because the on-chain seal_approve_audit function
      // has not been wired to real key server IDs.
      const res = await apiFetch<{ data?: unknown; unavailable?: boolean; reason?: string }>(
        `/audit/decrypt?capId=${encodeURIComponent(cap.capId)}&blobId=${encodeURIComponent(blobId.trim())}`,
      )
      if (res.unavailable) {
        setDecryptError(
          `SEAL decrypt pending backend${res.reason ? `: ${res.reason}` : ''}`,
        )
      } else {
        setDecryptResult(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2))
      }
    } catch (e) {
      setDecryptError((e as Error).message || 'Decrypt failed')
    } finally {
      setDecrypting(false)
    }
  }

  function decrypt() {
    if (canDecrypt) {
      void decryptViaSeal()
    } else {
      void decryptFallback()
    }
  }

  const buttonDisabled = !isValid || !blobId.trim() || decrypting

  return (
    <Card className="p-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
        <div className="space-y-1 min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
            Cap ID
          </p>
          <p className="font-mono text-sm text-lh-text-dim break-all">
            <a
              href={`${config.links.explorerBase}/object/${cap.capId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-lh-accent transition-colors"
            >
              {truncateId(cap.capId)}
              <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </p>
        </div>
        <span
          className={cnm(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1 shrink-0',
            'font-mono text-[10px] uppercase tracking-[0.12em]',
            isValid
              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25'
              : 'bg-red-500/10 text-red-300 border border-red-500/25',
          )}
        >
          <span
            className={cnm(
              'inline-block w-1.5 h-1.5 rounded-full',
              isValid ? 'bg-emerald-400' : 'bg-red-400',
            )}
            aria-hidden="true"
          />
          {isValid ? 'Valid' : 'Expired'} · {timeLabel}
        </span>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs mb-5">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-0.5">
            Profile Object
          </dt>
          <dd className="font-mono text-lh-text-dim break-all">
            <a
              href={`${config.links.explorerBase}/object/${cap.profileObjectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-lh-accent transition-colors"
            >
              {truncateId(cap.profileObjectId)}
              <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-0.5">
            Trader address
          </dt>
          <dd className="font-mono text-lh-text-dim break-all">
            <a
              href={`${config.links.explorerBase}/account/${cap.ownerAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-lh-accent transition-colors"
            >
              {truncateId(cap.ownerAddress)}
              <ExternalLink size={10} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </dd>
        </div>
      </dl>

      {/* Decrypt mode indicator */}
      {isValid && (
        <p className="text-[10px] font-mono text-lh-text-mute mb-3">
          {canDecrypt ? (
            <span className="text-emerald-400">
              Client-side SEAL decrypt active
            </span>
          ) : (
            <span className="text-amber-400">
              {!LIGHTHOUSE_PACKAGE_ID
                ? 'Set VITE_LIGHTHOUSE_PACKAGE_ID to enable client-side SEAL decrypt'
                : !account
                  ? 'Connect wallet to enable client-side SEAL decrypt'
                  : 'Backend fallback mode'}
            </span>
          )}
        </p>
      )}

      {/* Decrypt form */}
      <div className="border-t border-lh-line pt-4 space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
          View encrypted data
        </p>
        <div className="flex gap-2">
          <input
            value={blobId}
            onChange={(e) => setBlobId(e.target.value)}
            disabled={!isValid || decrypting}
            placeholder="Walrus blob ID…"
            className={cnm(
              'flex-1 min-w-0 rounded-xl border border-lh-line bg-lh-bg/60',
              'px-3 py-2 text-sm font-mono focus:outline-none focus:border-lh-accent/60 transition-colors',
              (!isValid || decrypting) && 'opacity-50 cursor-not-allowed',
            )}
          />
          <button
            type="button"
            onClick={decrypt}
            disabled={buttonDisabled}
            title={!isValid ? 'Cap expired' : 'Decrypt via SEAL'}
            className={cnm(
              'rounded-xl border border-lh-line px-4 py-2 text-sm font-semibold shrink-0 transition-colors',
              buttonDisabled
                ? 'opacity-40 cursor-not-allowed text-lh-text-mute'
                : 'text-lh-text hover:border-lh-accent/50 hover:text-lh-accent',
            )}
          >
            {decrypting ? '…' : 'Decrypt'}
          </button>
        </div>
        {!isValid && (
          <p className="text-[11px] text-lh-text-mute">
            SEAL decrypt requires a valid cap. This cap has expired.
          </p>
        )}

        {decryptError && (
          <p className="text-xs text-red-400" role="alert">
            {decryptError}
          </p>
        )}

        {decryptResult !== null && (
          <pre className="rounded-xl border border-lh-line bg-lh-bg/60 px-4 py-3 text-xs text-lh-text-dim overflow-x-auto whitespace-pre-wrap break-words">
            {decryptResult}
          </pre>
        )}
      </div>
    </Card>
  )
}
