import { useEffect } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

import { requireAuth } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'
import { MemWalBootstrapCard } from '@/components/portfolio/MemWalBootstrapCard'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Container } from '@/components/ui/Container'
import AppNav from '@/components/ui/AppNav'

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

  // When memwalAccountId becomes set (either because MemWalBootstrapCard
  // invalidated ['auth', 'profile-me'] and it re-fetched, or because the
  // user already had one and landed here by accident), navigate forward.
  // 600ms delay lets the "MemWal bootstrapped" success message register.
  useEffect(() => {
    if (!profile?.memwalAccountId) return
    const t = setTimeout(() => {
      void navigate({ to: destination as never, replace: true })
    }, 600)
    return () => clearTimeout(t)
  }, [profile?.memwalAccountId, destination, navigate])

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

            {/* Bootstrap action */}
            <MemWalBootstrapCard profile={profile} />
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
