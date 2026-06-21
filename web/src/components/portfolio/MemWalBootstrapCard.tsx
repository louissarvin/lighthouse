import { useState } from 'react'

import type { ProfileMe } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

interface Props {
  profile: ProfileMe
}

export function MemWalBootstrapCard({ profile: _profile }: Props) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function bootstrap() {
    setError(null)
    setPending(true)
    try {
      const data = await apiFetch<{ oauthUrl: string }>('/auth/web/start', {
        method: 'POST',
        body: {
          action: 'memwal_setup',
          next: '/portfolio',
        },
      })
      window.location.href = data.oauthUrl
    } catch (e) {
      setError((e as Error).message ?? 'Bootstrap failed')
      setPending(false)
    }
  }

  return (
    <Card className="p-6 md:p-8">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-3">
        MemWal · Encrypted memory
      </p>
      <h3 className="text-lg font-semibold mb-2">
        Set up your encrypted memory
      </h3>
      <p className="text-sm text-lh-text-dim mb-5 max-w-prose">
        Coach needs MemWal to recall your goals, risk profile, and past lessons.
        We'll bounce through Google to sign the bootstrap transactions
        server-side — takes about a second.
      </p>

      <button
        type="button"
        onClick={() => void bootstrap()}
        disabled={pending}
        className={cnm(
          'w-full rounded-full py-3 text-sm font-semibold transition-colors',
          'bg-lh-accent text-lh-bg',
          'hover:bg-lh-accent-warm',
          pending && 'opacity-50 cursor-not-allowed',
        )}
      >
        {pending ? (
          <span className="inline-flex items-center justify-center gap-2">
            <span
              className="inline-block w-3.5 h-3.5 rounded-full border-2 border-lh-bg/30 border-t-lh-bg animate-spin"
              aria-hidden="true"
            />
            Redirecting to Google…
          </span>
        ) : (
          'Bootstrap MemWal'
        )}
      </button>

      {error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}
