import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'

import type { AnchorReplyResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

const MAX_CHARS = 16_000

type Phase = 'idle' | 'loading' | 'done' | 'error'

export function AnchorNoteCard() {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<AnchorReplyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function anchor() {
    if (text.trim().length < 3 || phase === 'loading') return
    setPhase('loading')
    setError(null)
    try {
      const resp = await apiFetch<AnchorReplyResponse>('/coach/anchor-reply', {
        method: 'POST',
        body: { text: text.trim() },
      })
      setResult(resp)
      setPhase('done')
    } catch (e) {
      setError((e as Error).message)
      setPhase('error')
    }
  }

  function copyBlob() {
    if (!result) return
    void navigator.clipboard.writeText(result.walrusBlobId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function reset() {
    setText('')
    setResult(null)
    setPhase('idle')
    setError(null)
  }

  const canSubmit = text.trim().length >= 3 && phase !== 'loading'

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

      {phase === 'done' && result ? (
        <div className="space-y-4">
          <p className="text-sm font-semibold text-lh-accent">Anchored</p>

          <div className="rounded-xl border border-lh-line bg-lh-bg/40 p-4 space-y-3 text-xs font-mono">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lh-text-mute">Blob</span>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lh-text truncate">
                  {result.walrusBlobId.slice(0, 8)}…
                </span>
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

            <div className="flex items-center justify-between gap-2">
              <span className="text-lh-text-mute">Tx</span>
              <a
                href={result.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-lh-accent hover:underline"
              >
                {result.auditAnchorTxDigest.slice(0, 8)}…
                <ExternalLink size={10} />
              </a>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <a
              href={result.receiptUrl}
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
            {phase === 'loading' ? 'Uploading to Walrus…' : 'Anchor on Sui'}
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
