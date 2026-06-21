import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

import { requireAuth } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch } from '@/lib/api'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Container } from '@/components/ui/Container'
import AppNav from '@/components/ui/AppNav'

interface PredictSetupSearch {
  next?: string
}

export const Route = createFileRoute('/predict-setup')({
  beforeLoad: requireAuth,
  validateSearch: (search): PredictSetupSearch => ({
    next:
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : undefined,
  }),
  component: PredictSetupPage,
  head: () => ({
    meta: [
      { title: 'Set up your prediction account · Lighthouse' },
      {
        name: 'description',
        content: 'Create your PredictManager — a shared on-chain object that holds your binary option positions.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

function PredictSetupPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ from: '/predict-setup' })
  const destination = search.next ?? '/setup'

  const [error, setError] = useState<string | null>(null)
  // Track whether we've already fired the auto-trigger so StrictMode's
  // double-mount in dev doesn't POST /auth/web/start twice.
  const triggered = useRef(false)

  // Already has a PredictManager — skip forward immediately.
  useEffect(() => {
    if (!profile?.predictManagerId) return
    void navigate({ to: destination as never, replace: true })
  }, [profile?.predictManagerId, destination, navigate])

  // Auto-trigger: fire the OAuth redirect after a short delay so the user
  // briefly sees the page before being sent to Google. No button required.
  useEffect(() => {
    if (triggered.current) return
    triggered.current = true

    const timer = setTimeout(() => {
      void startOAuth()
    }, 500)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startOAuth() {
    setError(null)
    try {
      const data = await apiFetch<{ oauthUrl: string }>('/auth/web/start', {
        method: 'POST',
        body: {
          action: 'predict_setup',
          next: destination,
        },
      })
      window.location.href = data.oauthUrl
    } catch (e) {
      setError((e as Error).message ?? 'Failed to start setup')
    }
  }

  if (!profile) return null

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-24 pb-20">
        <Container>
          <div className="max-w-2xl mx-auto space-y-6">
            {/* Header */}
            <div>
              <EyebrowTag prefix="dot" className="mb-3">
                Step 2 of 3
              </EyebrowTag>
              <h1 className="text-3xl font-bold tracking-[-0.03em] mb-2">
                Set up your prediction account
              </h1>
              <p className="text-lh-text-dim text-sm max-w-lg">
                {error
                  ? 'Something went wrong. You can retry below.'
                  : 'Setting up your PredictManager — redirecting to Google…'}
              </p>
            </div>

            {/* Why this matters */}
            <div className="rounded-2xl border border-lh-line bg-lh-bg-elev/40 p-5 space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
                Why this matters
              </p>
              <ul className="space-y-2">
                {WHY_BULLETS.map((text) => (
                  <li key={text} className="flex items-start gap-2.5">
                    <span
                      className="mt-[3px] inline-block w-1 h-1 rounded-full bg-lh-accent shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-sm text-lh-text-dim leading-snug">
                      {text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Status / error */}
            <div className="space-y-3">
              {!error && (
                <div className="w-full rounded-full py-3 text-sm font-semibold bg-lh-accent text-lh-bg flex items-center justify-center gap-2 opacity-60 cursor-not-allowed select-none">
                  <span
                    className="inline-block w-3.5 h-3.5 rounded-full border-2 border-lh-bg/30 border-t-lh-bg animate-spin"
                    aria-hidden="true"
                  />
                  Redirecting to Google…
                </div>
              )}

              {error && (
                <div className="space-y-2">
                  <p className="text-xs text-red-400 text-center" role="alert">
                    {error}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startOAuth()}
                    className="w-full rounded-full py-3 text-sm font-semibold bg-lh-accent text-lh-bg hover:bg-lh-accent-warm transition-colors"
                  >
                    Set up PredictManager
                  </button>
                </div>
              )}
            </div>
          </div>
        </Container>
      </section>
    </main>
  )
}

const WHY_BULLETS = [
  'Holds your BTC/SUI binary option positions in a shared on-chain object',
  'Funded by your wallet — Lighthouse never touches your balance directly',
  'One sponsored transaction, no gas popups',
] as const
