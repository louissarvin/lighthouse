'use client'

import { useState } from 'react'
import { cnm } from '@/utils/style'
import { Check, Copy } from '@/constants/icons'

interface CodeBlockProps {
  code: string
  lang: string
  filename?: string
}

export function CodeBlock({ code, lang, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="rounded-lg border border-lh-line overflow-hidden my-6">
      {/* Header bar */}
      <div className="flex items-center justify-between h-9 px-4 border-b border-lh-line bg-lh-bg-elev">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute">
          {filename ?? lang}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          className={cnm(
            'flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em]',
            'transition-colors duration-150',
            copied ? 'text-lh-accent' : 'text-lh-text-mute hover:text-lh-text',
          )}
        >
          {copied ? (
            <Check size={12} strokeWidth={2} />
          ) : (
            <Copy size={12} strokeWidth={1.5} />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Code area — plain pre/code without Shiki for Phase 4.
          Shiki requires async SSR that is incompatible with TanStack Start's
          synchronous loader pattern. Phase 5 will upgrade to server-rendered
          Shiki HTML. The dangerouslySetInnerHTML path is intentionally unused
          here because we cannot guarantee Shiki output is available at render
          time on the client without an async fetch.
          Plain pre/code is safe: no user input reaches this component. */}
      <div className="p-4 overflow-x-auto bg-lh-bg-elev/60">
        <pre className="text-[13px] leading-[1.6] text-lh-text-dim font-mono whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}
