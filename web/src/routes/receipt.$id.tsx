import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useParams } from '@tanstack/react-router'

import type { ProofResponse } from '@/lib/types'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { Skeleton } from '@/components/ui/Skeleton'
import { Card } from '@/components/ui/Card'
import { ProofCard } from '@/components/receipt/ProofCard'
import { ApiError, apiFetch } from '@/lib/api'

/**
 * Public verifiable receipt. Tries `/proof/recommendation/:id` first, falls
 * back to `/proof/trade/:id` so the same URL works whether the id refers to
 * a coach recommendation or an executor trade.
 */
async function fetchProof(id: string): Promise<ProofResponse> {
  try {
    return await apiFetch<ProofResponse>(`/proof/recommendation/${id}`, {
      noCredentials: true,
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return await apiFetch<ProofResponse>(`/proof/trade/${id}`, {
        noCredentials: true,
      })
    }
    throw e
  }
}

export const Route = createFileRoute('/receipt/$id')({
  component: ReceiptPage,
  head: ({ params }) => ({
    meta: [
      { title: `Receipt ${params.id.slice(0, 10)} · Lighthouse` },
      {
        name: 'description',
        content:
          'Verifiable AI trade receipt — Atoma inference, SEAL access policy, Walrus blob, on-chain anchor.',
      },
      { property: 'og:title', content: 'Lighthouse verifiable receipt' },
    ],
  }),
})

function ReceiptPage() {
  const { id } = useParams({ from: '/receipt/$id' })

  const { data, isLoading, error } = useQuery<ProofResponse>({
    queryKey: ['proof', id],
    queryFn: () => fetchProof(id),
    retry: false,
    staleTime: Infinity,
  })

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <PillNav />
      <section className="pt-32 pb-20">
        <Container>
          {isLoading && (
            <div className="space-y-6">
              <Skeleton className="h-32" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Skeleton className="h-64" />
                <Skeleton className="h-64" />
              </div>
            </div>
          )}

          {error && !isLoading && (
            <Card className="p-8 max-w-xl mx-auto text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] mb-3">
                Receipt not found
              </h1>
              <p className="text-sm text-lh-text-dim leading-relaxed mb-4">
                {(error).message ??
                  'No recommendation or trade matches this id.'}
              </p>
              <p className="font-mono text-xs text-lh-text-mute">{id}</p>
            </Card>
          )}

          {data && <ProofCard proof={data} />}
        </Container>
      </section>
      <FooterCard />
    </main>
  )
}
