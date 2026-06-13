import { createFileRoute } from '@tanstack/react-router'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: 'Terms of Service | Lighthouse' },
      { name: 'description', content: 'Lighthouse terms of service.' },
    ],
  }),
})

function TermsPage() {
  return (
    <main className="bg-lh-bg text-lh-text min-h-screen flex flex-col">
      <PillNav />
      <div className="flex-1 pt-40 pb-24">
        <Container>
          <EyebrowTag dot className="mb-6">
            Terms of Service
          </EyebrowTag>
          <h1 className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text mb-6 max-w-xl">
            Terms of Service
          </h1>
          <p className="text-base text-lh-text-dim leading-[1.7] max-w-2xl">
            Full terms of service coming soon. For questions, contact{' '}
            <a
              href="mailto:team@lighthouse.com"
              className="text-lh-accent-warm hover:underline"
            >
              team@lighthouse.com
            </a>
            .
          </p>
        </Container>
      </div>
      <FooterCard />
    </main>
  )
}
