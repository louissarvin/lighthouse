import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

import PillNav from '@/components/landing/PillNav'
import { Container } from '@/components/ui/Container'
import { Skeleton } from '@/components/ui/Skeleton'
import { ApiError, apiFetch } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

// Module-level in-flight cache so React StrictMode's double-mount in dev
// (and any unforeseen remount) does not POST /auth/web/set-cookie twice
// with the same single-use handoff token. First fire kicks off the exchange,
// subsequent fires await the same promise.
const inflightHandoffs = new Map<string, Promise<void>>()

/**
 * Exchange the handoff token for the lh_jwt cookie. Idempotent across remounts.
 * A "handoff already used" response from the backend is treated as success —
 * it means a prior call already burned the token and set the cookie.
 */
function exchangeHandoffOnce(handoff: string): Promise<void> {
  const existing = inflightHandoffs.get(handoff)
  if (existing) return existing
  const promise = (async () => {
    try {
      await apiFetch('/auth/web/set-cookie', {
        method: 'POST',
        body: { handoff },
      })
    } catch (e) {
      // If the error is the duplicate-burn case, the cookie was set by the
      // first fire. Anything else propagates.
      const msg = (e as Error).message?.toLowerCase() ?? ''
      const isAlreadyUsed =
        e instanceof ApiError &&
        (e.status === 400 || e.status === 409) &&
        (msg.includes('already') ||
          msg.includes('used') ||
          msg.includes('consumed') ||
          e.code === 'HANDOFF_USED' ||
          e.code === 'HANDOFF_CONSUMED')
      if (!isAlreadyUsed) throw e
    }
  })()
  inflightHandoffs.set(handoff, promise)
  return promise
}

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
        await exchangeHandoffOnce(search.handoff)
        if (cancelled) return
        const freshProfile = await refresh()
        if (cancelled) return
        setStage('redirecting')
        const intendedNext = search.next ?? '/coach'
        // Route the user through any missing onboarding steps before landing
        // on the intended destination. Order: memwal → risk profile → dest.
        let next: string
        if (!freshProfile?.memwalAccountId) {
          const afterMemwal = !freshProfile?.riskProfileCompletedAt
            ? `/setup?next=${encodeURIComponent(intendedNext)}`
            : intendedNext
          next = `/memwal-setup?next=${encodeURIComponent(afterMemwal)}`
        } else if (freshProfile && !freshProfile.riskProfileCompletedAt) {
          next = `/setup?next=${encodeURIComponent(intendedNext)}`
        } else {
          next = intendedNext
        }
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
