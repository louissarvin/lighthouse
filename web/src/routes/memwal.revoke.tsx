import { useState } from 'react'
import { Link, createFileRoute, useSearch } from '@tanstack/react-router'

import AppNav from '@/components/ui/AppNav'
import { Card } from '@/components/ui/Card'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { apiFetch } from '@/lib/api'
import { requireAuth } from '@/lib/requireAuth'
import { cnm } from '@/utils/style'

interface RevokeSearch {
  account?: string
}

interface RevokeResponse {
  revoked: boolean
  alreadyClear: boolean
}

export const Route = createFileRoute('/memwal/revoke')({
  beforeLoad: requireAuth,
  validateSearch: (search): RevokeSearch => ({
    account: typeof search.account === 'string' ? search.account : undefined,
  }),
  component: MemWalRevokePage,
  head: () => ({
    meta: [{ title: 'Revoke MemWal Access · Lighthouse' }],
  }),
})

function MemWalRevokePage() {
  const search = useSearch({ from: '/memwal/revoke' })
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRevoke() {
    setPending(true)
    setError(null)
    try {
      await apiFetch<RevokeResponse>('/memwal/revoke', {
        method: 'POST',
        body: {},
      })
      setSuccess(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-32 pb-20">
        <Container>
          <div className="max-w-[480px] mx-auto text-center">
            <EyebrowTag prefix="dash" className="mb-6">
              MemWal · Delegate key
            </EyebrowTag>
            <h1 className="text-4xl md:text-5xl font-bold tracking-[-0.03em] mb-4">
              Revoke Memory Access
            </h1>
            <p className="text-lh-text-dim text-base leading-relaxed mb-6">
              This removes the Lighthouse backend's ability to write new
              memories on your behalf. Existing memories on Walrus are
              unaffected — only new writes will fail. To re-enable memory, run
              the MemWal setup again from the onboarding flow.
            </p>

            {search.account && (
              <p className="text-xs font-mono text-lh-text-mute mb-6">
                Account: {search.account}
              </p>
            )}

            <Card className="p-4 mb-8 rounded-2xl border border-amber-500/30 bg-amber-500/5 shadow-none text-left">
              <p className="text-sm text-amber-300 leading-relaxed">
                After revoking, coach recommendations and the risk profile
                wizard will stop writing to your memory until you re-grant
                access.
              </p>
            </Card>

            {success ? (
              <div className="space-y-4">
                <p className="text-sm text-emerald-400" role="status">
                  Delegate key revoked. No new memories will be written until
                  you re-run MemWal setup.
                </p>
                <Link
                  to="/portfolio"
                  className={cnm(
                    'inline-flex items-center gap-2 rounded-full',
                    'border border-lh-line text-lh-text-dim',
                    'text-sm px-5 py-2.5 leading-none',
                    'hover:text-lh-text transition-colors',
                  )}
                >
                  Go to Portfolio
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={pending}
                  className={cnm(
                    'rounded-full px-8 py-3 text-sm font-semibold transition-colors',
                    pending
                      ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25',
                  )}
                >
                  {pending ? 'Revoking…' : 'Revoke delegate key'}
                </button>

                {error && (
                  <p className="text-sm text-red-400" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        </Container>
      </section>
    </main>
  )
}
