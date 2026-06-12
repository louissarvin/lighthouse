import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useParams } from '@tanstack/react-router'

import type { TearsheetResponse } from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { Skeleton } from '@/components/ui/Skeleton'
import { Card } from '@/components/ui/Card'
import { TearsheetCard } from '@/components/tearsheet/TearsheetCard'
import { apiFetch } from '@/lib/api'

/**
 * Public weekly tearsheet at `/u/<suins_name>/<week>`.
 *
 * SuiNS-style name in the URL: `alice.sui/2026-W22`. We pass the `.sui`
 * suffix through verbatim so backend resolution matches what suins.io stores.
 *
 * Read-only, no auth — anyone with the URL can verify the tearsheet on
 * Walrus.
 */
export const Route = createFileRoute('/u/$name/$week')({
  component: PublicTearsheetPage,
  head: ({ params }) => ({
    meta: [
      { title: `${params.name} · ${params.week} · Lighthouse` },
      {
        name: 'description',
        content: `Public Walrus tearsheet for ${params.name} during ${params.week}. Verifiable trading activity, no PnL claims.`,
      },
    ],
  }),
})

function PublicTearsheetPage() {
  const { name, week } = useParams({ from: '/u/$name/$week' })

  const { data, isLoading, error } = useQuery<TearsheetResponse>({
    queryKey: ['tearsheet', name, week],
    queryFn: () =>
      apiFetch<TearsheetResponse>(
        `/tearsheet/by-suins/${encodeURIComponent(name)}/${encodeURIComponent(week)}`,
        { noCredentials: true },
      ),
    retry: false,
    staleTime: 60_000,
  })

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          {isLoading && (
            <div className="space-y-6">
              <Skeleton className="h-40" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
              </div>
            </div>
          )}

          {error && !isLoading && (
            <Card className="p-8 max-w-xl mx-auto text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] mb-3">
                Tearsheet not found
              </h1>
              <p className="text-sm text-lh-text-dim leading-relaxed mb-2">
                {(error).message ??
                  `No tearsheet for ${name} during ${week}.`}
              </p>
              <p className="font-mono text-xs text-lh-text-mute">
                {name} / {week}
              </p>
            </Card>
          )}

          {data && <TearsheetCard data={data} />}
        </Container>
      </section>
      <FooterCard />
    </main>
  )
}
