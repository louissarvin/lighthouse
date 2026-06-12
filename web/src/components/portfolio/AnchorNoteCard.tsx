import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import {
  useCurrentAccount,
  useSignTransaction,
  useSuiClient,
} from '@mysten/dapp-kit'
import type { Signer } from '@mysten/sui/cryptography'

import type { AnchorReplyResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { walrusBlobUrl } from '@/lib/walrus'
import { uploadTextToWalrus } from '@/lib/walrus-write'

const MAX_CHARS = 16_000

type Phase = 'idle' | 'loading' | 'done' | 'error'
type Mode = 'server' | 'browser'

interface BrowserResult {
  blobId: string
  suiObjectId: string
}

const EXPLORER_BASE =
  (import.meta.env.VITE_SUI_NETWORK as string | undefined) === 'mainnet'
    ? 'https://suiscan.xyz/mainnet'
    : 'https://suiscan.xyz/testnet'

export function AnchorNoteCard() {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [mode, setMode] = useState<Mode>('server')
  const [serverResult, setServerResult] = useState<AnchorReplyResponse | null>(null)
  const [browserResult, setBrowserResult] = useState<BrowserResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const suiClient = useSuiClient()
  const account = useCurrentAccount()
  const { mutateAsync: signTransaction } = useSignTransaction()

  async function anchorServer() {
    setPhase('loading')
    setError(null)
    try {
      const resp = await apiFetch<AnchorReplyResponse>('/coach/anchor-reply', {
        method: 'POST',
        body: { text: text.trim() },
      })
      setServerResult(resp)
      setPhase('done')
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  async function anchorBrowser() {
    if (!account) {
      setError('Connect wallet to write directly to Walrus.')
      setPhase('error')
      return
    }
    setPhase('loading')
    setError(null)
    try {
      // Build a Signer adapter: the Walrus SDK Signer interface takes a
      // signTransaction(bytes) method. We delegate to dapp-kit's hook.
      const signer = {
        toSuiAddress: () => account.address,
        signTransaction: async (bytes: Uint8Array) => {
          const { Transaction } = await import('@mysten/sui/transactions')
          const tx = Transaction.from(bytes)
          const result = await signTransaction({ transaction: tx, account })
          return { signature: result.signature, bytes: result.bytes }
        },
        signWithIntent: async () => {
          throw new Error('signWithIntent not supported')
        },
      } as unknown as Signer

      const result = await uploadTextToWalrus(text.trim(), suiClient, signer)
      setBrowserResult(result)
      setPhase('done')
    } catch (e) {
      const msg = (e as Error).message ?? 'Walrus upload failed'
      // Graceful fallback: insufficient WAL balance is the most common failure.
      if (
        msg.toLowerCase().includes('insufficient') ||
        msg.toLowerCase().includes('wal') ||
        msg.toLowerCase().includes('balance')
      ) {
        setError(
          `Browser-signed upload failed (likely insufficient WAL balance). ` +
          `Switch to Server-signed mode. Error: ${msg}`,
        )
        setMode('server')
      } else {
        setError(msg)
      }
      setPhase('error')
    }
  }

  function anchor() {
    if (text.trim().length < 3 || phase === 'loading') return
    void (mode === 'browser' ? anchorBrowser() : anchorServer())
  }

  function copyBlob() {
    const id = serverResult?.walrusBlobId ?? browserResult?.blobId
    if (!id) return
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function reset() {
    setText('')
    setServerResult(null)
    setBrowserResult(null)
    setPhase('idle')
    setError(null)
  }

  const canSubmit = text.trim().length >= 3 && phase !== 'loading'
  const blobId = serverResult?.walrusBlobId ?? browserResult?.blobId ?? null
  const blobUrl = walrusBlobUrl(blobId)

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="dot" className="mb-3">
        Walrus + Sui
      </EyebrowTag>
      <h3 className="text-lg font-semibold mb-1">Anchor a Note</h3>
      <p className="text-sm text-lh-text-dim mb-5">
        Pin any text permanently to Walrus and record a tamper-proof receipt on
        Sui.
      </p>

      {phase === 'done' && (serverResult ?? browserResult) ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-lh-accent">Anchored</p>
            {browserResult && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300 uppercase tracking-[0.12em]">
                Self-custody
              </span>
            )}
          </div>

          <div className="rounded-xl border border-lh-line bg-lh-bg/40 p-4 space-y-3 text-xs font-mono">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lh-text-mute">Blob</span>
              <div className="flex items-center gap-2 min-w-0">
                {blobUrl ? (
                  <a
                    href={blobUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-lh-accent hover:underline truncate"
                    title={blobId ?? ''}
                  >
                    {blobId?.slice(0, 8)}…
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  <span className="text-lh-text truncate">
                    {blobId?.slice(0, 8)}…
                  </span>
                )}
                <button
                  type="button"
                  onClick={copyBlob}
                  className="shrink-0 text-lh-text-mute hover:text-lh-text transition-colors"
                  aria-label="Copy blob ID"
                >
                  <Copy size={12} />
                </button>
                {copied && (
                  <span className="text-lh-accent text-[10px]">copied</span>
                )}
              </div>
            </div>

            {serverResult && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-lh-text-mute">Tx</span>
                <a
                  href={serverResult.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-lh-accent hover:underline"
                >
                  {serverResult.auditAnchorTxDigest.slice(0, 8)}…
                  <ExternalLink size={10} />
                </a>
              </div>
            )}

            {browserResult && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-lh-text-mute">Blob object</span>
                <a
                  href={`${EXPLORER_BASE}/object/${browserResult.suiObjectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-lh-accent hover:underline"
                >
                  {browserResult.suiObjectId.slice(0, 10)}…
                  <ExternalLink size={10} />
                </a>
              </div>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            {serverResult && (
              <a
                href={serverResult.receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cnm(
                  'inline-flex items-center gap-1.5 rounded-full border border-lh-line',
                  'px-4 py-2 text-xs font-semibold text-lh-text-dim',
                  'hover:border-lh-line-mid hover:text-lh-text transition-colors',
                )}
              >
                View Receipt
                <ExternalLink size={10} />
              </a>
            )}
            <button
              type="button"
              onClick={reset}
              className={cnm(
                'inline-flex items-center rounded-full border border-lh-line',
                'px-4 py-2 text-xs font-semibold text-lh-text-dim',
                'hover:border-lh-line-mid hover:text-lh-text transition-colors',
              )}
            >
              New Note
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Mode toggle */}
          <div className="flex items-center gap-1 p-0.5 rounded-full border border-lh-line bg-lh-bg/40 mb-4 w-fit">
            <button
              type="button"
              onClick={() => setMode('server')}
              className={cnm(
                'rounded-full px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] transition-colors',
                mode === 'server'
                  ? 'bg-lh-bg-elev text-lh-text border border-lh-line'
                  : 'text-lh-text-mute hover:text-lh-text',
              )}
            >
              Server-signed
            </button>
            <button
              type="button"
              onClick={() => setMode('browser')}
              className={cnm(
                'rounded-full px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.12em] transition-colors',
                mode === 'browser'
                  ? 'bg-lh-bg-elev text-lh-text border border-lh-line'
                  : 'text-lh-text-mute hover:text-lh-text',
              )}
            >
              Browser-signed
            </button>
          </div>

          {mode === 'browser' && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-300 leading-relaxed">
              Your Enoki key signs the Walrus upload tx directly — the blob
              object is owned by you, not the backend. Requires ~0.5 WAL + gas.
              {!account && (
                <span className="block mt-1 text-amber-200">
                  Connect your wallet first.
                </span>
              )}
            </div>
          )}

          <label className="block mb-2">
            <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
              Note
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
              disabled={phase === 'loading'}
              rows={5}
              className={cnm(
                'w-full rounded-xl border border-lh-line bg-lh-bg/60',
                'px-4 py-3 text-sm text-lh-text placeholder:text-lh-text-mute',
                'focus:outline-none focus:border-lh-accent transition-colors resize-none',
                phase === 'loading' && 'opacity-50 cursor-not-allowed',
              )}
              placeholder="Write anything you want anchored permanently…"
            />
          </label>
          <p className="text-right font-mono text-[10px] text-lh-text-mute mb-5">
            {text.length.toLocaleString('en-US')} / 16 000
          </p>

          <GlowBorderButton
            as="button"
            onClick={anchor}
            size="md"
            className={cnm(
              'w-full',
              !canSubmit && 'opacity-50 pointer-events-none',
            )}
          >
            {phase === 'loading'
              ? mode === 'browser'
                ? 'Writing to Walrus…'
                : 'Uploading to Walrus…'
              : mode === 'browser'
                ? 'Write to Walrus (self-custody)'
                : 'Anchor on Sui'}
          </GlowBorderButton>
        </>
      )}

      {phase === 'error' && error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}
