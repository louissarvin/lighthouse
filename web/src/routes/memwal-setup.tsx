import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

import { requireAuth } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch } from '@/lib/api'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Container } from '@/components/ui/Container'
import AppNav from '@/components/ui/AppNav'
import { cnm } from '@/utils/style'

interface MemWalSetupSearch {
  next?: string
}

export const Route = createFileRoute('/memwal-setup')({
  beforeLoad: requireAuth,
  validateSearch: (search): MemWalSetupSearch => ({
    next:
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : undefined,
  }),
  component: MemWalSetupPage,
  head: () => ({
    meta: [
      { title: 'Set up your memory · Lighthouse' },
      {
        name: 'description',
        content:
          'Bootstrap your encrypted MemWal account so your coach remembers your goals across sessions.',
      },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

function MemWalSetupPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const search = useSearch({ from: '/memwal-setup' })
  const destination = search.next ?? '/setup'

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Already bootstrapped — skip forward immediately.
  useEffect(() => {
    if (!profile?.memwalAccountId) return
    void navigate({ to: destination as never, replace: true })
  }, [profile?.memwalAccountId, destination, navigate])

  if (!profile) return null

  async function handleBootstrap() {
    setError(null)
    setPending(true)
    try {
      const data = await apiFetch<{ oauthUrl: string }>('/auth/web/start', {
        method: 'POST',
        body: {
          action: 'memwal_setup',
          next: destination,
        },
      })
      window.location.href = data.oauthUrl
    } catch (e) {
      setError((e as Error).message ?? 'Failed to start bootstrap')
      setPending(false)
    }
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-24 pb-20">
        <Container>
          <div className="max-w-2xl mx-auto space-y-6">
            {/* Header */}
            <div>
              <EyebrowTag prefix="dot" className="mb-3">
                Step 1 of 2
              </EyebrowTag>
              <h1 className="text-3xl font-bold tracking-[-0.03em] mb-2">
                Set up your encrypted memory
              </h1>
              <p className="text-lh-text-dim text-sm max-w-lg">
                Before your coach can advise you across sessions, we'll create
                your MemWal — an encrypted, on-chain memory store only you can
                read. Two quick sponsored transactions, no popups.
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

            {/* CTA */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void handleBootstrap()}
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
                <div className="space-y-2">
                  <p className="text-xs text-red-400 text-center" role="alert">
                    {error}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleBootstrap()}
                    className="w-full rounded-full py-2.5 text-sm font-semibold border border-lh-line text-lh-text-dim hover:text-lh-text hover:border-lh-text-dim transition-colors"
                  >
                    Retry
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
  'Your risk profile, lessons learned, and goals are saved here',
  'Encrypted by your zkLogin keys — nobody else can read it',
  'The coach references this in every conversation',
] as const
