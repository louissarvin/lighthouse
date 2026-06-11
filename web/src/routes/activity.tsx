import { createFileRoute } from '@tanstack/react-router'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import ActivityStream from '@/components/landing/ActivityStream'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
  head: () => ({
    meta: [
      { title: 'Chain Activity | Lighthouse' },
      {
        name: 'description',
        content:
          'Every transaction Lighthouse anchors on Sui, displayed in real time. No editing, no curation.',
      },
    ],
  }),
})

// ActivityHero — softer than the landing hero per LIGHTHOUSE_TYPOGRAPHY.md:
// Inter 700, not 800. No italic accent word (reserved for /). No beam.
// Section padding follows LIGHTHOUSE_LAYOUT_COMPONENTS.md §1 feature-card-grid ladder:
// py-16 md:py-20 desktop:py-24.
function ActivityHero() {
  return (
    <section
      aria-labelledby="activity-hero-h1"
      className="pt-32 pb-16 md:pb-20"
    >
      <Container>
        <EyebrowTag dot className="mb-4">
          Alive on testnet
        </EyebrowTag>
        <h1
          id="activity-hero-h1"
          className="text-4xl md:text-[64px] font-bold leading-[1.05] tracking-[-0.03em] text-lh-text mb-6 max-w-2xl"
        >
          Real-time chain activity
        </h1>
        <p className="text-base md:text-lg text-lh-text-dim leading-relaxed max-w-xl">
          Every transaction Lighthouse anchors on Sui shows up here within
          seconds. No editing, no curation.
        </p>
      </Container>
    </section>
  )
}

function ActivityPage() {
  return (
    <main className="bg-lh-bg text-lh-text">
      <PillNav />
      <ActivityHero />

      {/* Activity stream section — py-12 md:py-16 per stats-strip ladder */}
      <section aria-label="On-chain activity feed" className="py-12 md:py-16">
        <Container>
          <ActivityStream />
        </Container>
      </section>

      <FooterCard />
    </main>
  )
}
