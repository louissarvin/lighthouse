import { useState } from 'react'
import { Link, createFileRoute, useSearch } from '@tanstack/react-router'
import { useConnectWallet, useWallets } from '@mysten/dapp-kit'
import { isEnokiWallet } from '@mysten/enoki'

import PillNav from '@/components/landing/PillNav'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { ArrowRight } from '@/constants/icons'
import { apiFetch } from '@/lib/api'

interface AuthSearch {
  next?: string
}

export const Route = createFileRoute('/auth')({
  validateSearch: (search): AuthSearch => {
    const next =
      typeof search.next === 'string' && search.next.startsWith('/')
        ? search.next
        : undefined
    return { next }
  },
  component: AuthPage,
  head: () => ({
    meta: [
      { title: 'Sign in · Lighthouse' },
      {
        name: 'description',
        content:
          'Sign in to Lighthouse with Google. zkLogin + Enoki, no seed phrase, no extension.',
      },
    ],
  }),
})

function AuthPage() {
  const search = useSearch({ from: '/auth' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wallets = useWallets()
  const { mutateAsync: connectWallet } = useConnectWallet()

  // Find the Enoki Google wallet registered by SuiEnokiProvider.
  const enokiGoogleWallet = wallets.find(
    (w) => isEnokiWallet(w) && w.provider === 'google',
  )

  async function startGoogle() {
    setError(null)
    setPending(true)
    // ── DIAGNOSTIC: log every registered wallet so we can see what's there.
    // Remove once the onboarding flow is verified working.
    // eslint-disable-next-line no-console
    console.log(
      '[auth] wallets visible to dapp-kit at click time:',
      wallets.map((w) => ({
        name: w.name,
        isEnoki: isEnokiWallet(w),
        provider: isEnokiWallet(w) ? w.provider : undefined,
      })),
    )
    // eslint-disable-next-line no-console
    console.log('[auth] env at runtime:', {
      enokiPublicKey: !!import.meta.env.VITE_ENOKI_PUBLIC_KEY,
      googleClientId: !!import.meta.env.VITE_GOOGLE_CLIENT_ID,
      origin: window.location.origin,
    })
    try {
      // 1. Trigger Enoki connect first (opens a popup for Google OAuth and
      //    persists the ephemeral key in IndexedDB). Must happen on the user
      //    gesture to avoid popup blockers. We HARD-FAIL if this errors —
      //    without an Enoki session the user can't sign any sponsored tx, and
      //    silent failure here leaves them stranded on /memwal-setup or /predict
      //    later with a cryptic "wallet not connected" message.
      if (!enokiGoogleWallet) {
        throw new Error(
          'Enoki wallet not registered. Check VITE_ENOKI_PUBLIC_KEY in web/.env ' +
            'and Allowed Origins in the Enoki Portal include ' +
            window.location.origin +
            '. See browser console for wallet list.',
        )
      }
      try {
        await connectWallet({ wallet: enokiGoogleWallet })
      } catch (enokiErr) {
        const msg = (enokiErr as Error).message ?? String(enokiErr)
        throw new Error(
          'Enoki sign-in failed: ' +
            msg +
            '. Most common cause: ' +
            window.location.origin +
            '/oauth-finish is not in your Google OAuth client\'s ' +
            'authorized redirect URIs, or ' +
            window.location.origin +
            ' is not in your Enoki Portal Allowed Origins. Open browser ' +
            'console for details.',
        )
      }

      // 2. Start the backend cookie flow (redirects to Google OAuth for lh_jwt).
      const data = await apiFetch<{ oauthUrl: string }>('/auth/web/start', {
        method: 'POST',
        body: { next: search.next ?? '/trade' },
      })
      window.location.href = data.oauthUrl
    } catch (e) {
      setError((e as Error).message ?? 'Could not start sign-in')
      setPending(false)
    }
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-[480px] mx-auto text-center">
            <EyebrowTag prefix="none" className="mb-6 mx-auto">
              <span className="inline-flex items-center gap-3">
                <img
                  src="/assets/marquee/sui.svg"
                  alt="Sui"
                  className="h-12 w-auto opacity-70"
                />
                <span aria-hidden="true">·</span>
                <img
                  src="/assets/marquee/zklogin.svg"
                  alt="zkLogin"
                  className="h-12 w-auto opacity-70"
                />
                <span aria-hidden="true">·</span>
                <img
                  src="/assets/marquee/enoki.svg"
                  alt="Enoki"
                  className="h-12 w-auto opacity-70"
                />
              </span>
            </EyebrowTag>
            <h1 className="text-4xl md:text-5xl font-bold tracking-[-0.03em] mb-4">
              Sign in to Lighthouse
            </h1>
            <p className="text-lh-text-dim text-base leading-relaxed mb-10">
              No seed phrase. No extension. Sign in with Google and Enoki
              provisions a Sui address for you — same account the Telegram bot
              uses.
            </p>

            <div className="flex flex-col items-center gap-4">
              <GlowBorderButton
                as="button"
                onClick={startGoogle}
                size="lg"
                ariaLabel="Continue with Google"
                className="min-w-[280px]"
              >
                {pending ? 'Signing in…' : 'Continue with Google'}
                <ArrowRight size={16} aria-hidden="true" />
              </GlowBorderButton>

              {error && (
                <p className="text-sm text-red-400" role="alert">
                  {error}
                </p>
              )}

              <p className="text-xs text-lh-text-mute mt-4">
                By signing in you accept the{' '}
                <Link
                  to="/terms"
                  className="text-lh-text-dim hover:text-lh-accent"
                >
                  Terms
                </Link>{' '}
                and{' '}
                <Link
                  to="/privacy"
                  className="text-lh-text-dim hover:text-lh-accent"
                >
                  Privacy
                </Link>{' '}
                policies. Your zkLogin proof and ephemeral keypair are managed
                by Enoki.
              </p>
            </div>
          </div>
        </Container>
      </section>
    </main>
  )
}
