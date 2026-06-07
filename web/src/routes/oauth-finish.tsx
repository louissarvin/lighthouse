import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

import PillNav from '@/components/landing/PillNav'
import { Container } from '@/components/ui/Container'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

interface OAuthFinishSearch {
  handoff?: string
  addr?: string
  next?: string
}

export const Route = createFileRoute('/oauth-finish')({
  validateSearch: (search): OAuthFinishSearch => ({
    handoff: typeof search.handoff === 'string' ? search.handoff : undefined,
    addr: typeof search.addr === 'string' ? search.addr : undefined,
    next:
      typeof search.next === 'string' && search.next.startsWith('/')
        ? search.next
        : undefined,
  }),
  component: OAuthFinishPage,
  head: () => ({
    meta: [
      { title: 'Signing in · Lighthouse' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})

function OAuthFinishPage() {
  const search = useSearch({ from: '/oauth-finish' })
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<'exchanging' | 'redirecting' | 'error'>(
    'exchanging',
  )

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!search.handoff) {
        setError('Missing handoff token. Please sign in again.')
        setStage('error')
        return
      }
      try {
        await apiFetch('/auth/web/set-cookie', {
          method: 'POST',
          body: { handoff: search.handoff },
        })
        if (cancelled) return
        const freshProfile = await refresh()
        if (cancelled) return
        setStage('redirecting')
        const intendedNext = search.next ?? '/coach'
        // If risk profile isn't complete, route through /setup so the user
        // completes onboarding before landing on the protected destination.
        const next =
          freshProfile && !freshProfile.riskProfileCompletedAt
            ? `/setup?next=${encodeURIComponent(intendedNext)}`
            : intendedNext
        setTimeout(() => {
          if (!cancelled) {
            navigate({ to: next as never, replace: true })
          }
        }, 350)
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message ?? 'Sign-in failed')
        setStage('error')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [search.handoff, search.next, refresh, navigate])

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-[420px] mx-auto text-center">
            {stage !== 'error' && (
              <>
                <div
                  className="mx-auto mb-6 inline-flex items-center justify-center w-12 h-12 rounded-full bg-lh-bg-elev border border-lh-line"
                  aria-hidden="true"
                >
                  <span className="text-lh-accent text-xl">✓</span>
                </div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-[-0.03em] mb-3">
                  Signed in to Lighthouse
                </h1>
                {search.addr && (
                  <p className="text-sm font-mono text-lh-text-mute mb-6">
                    {search.addr.slice(0, 12)}…{search.addr.slice(-6)}
                  </p>
                )}
                <p className="text-lh-text-dim text-base mb-6">
                  {stage === 'exchanging'
                    ? 'Setting up your session…'
                    : 'Taking you to the app…'}
                </p>
                <div className="space-y-2 max-w-[260px] mx-auto">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </>
            )}
            {stage === 'error' && (
              <>
                <h1 className="text-3xl font-bold tracking-[-0.03em] mb-3">
                  Sign-in failed
                </h1>
                <p className="text-lh-text-dim text-base mb-6">
                  {error ?? 'Unknown error during sign-in.'}
                </p>
                <a
                  href="/auth"
                  className="inline-flex items-center gap-2 rounded-full bg-lh-accent text-lh-bg font-semibold text-sm px-5 py-2.5"
                >
                  Try again
                </a>
              </>
            )}
          </div>
        </Container>
      </section>
    </main>
  )
}
