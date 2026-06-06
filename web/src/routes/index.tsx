import { createFileRoute } from '@tanstack/react-router'
import PillNav from '@/components/landing/PillNav'
import Hero from '@/components/landing/Hero'
import StatsStrip from '@/components/landing/StatsStrip'
import ThesisParagraph from '@/components/landing/ThesisParagraph'
import WhatIsLighthouse from '@/components/landing/WhatIsLighthouse'
import Walkthrough from '@/components/landing/Walkthrough'
import PrimitivesGrid from '@/components/landing/PrimitivesGrid'
import FAQ from '@/components/landing/FAQ'
import FooterCard from '@/components/landing/FooterCard'

export const Route = createFileRoute('/')({ component: IndexPage })

function IndexPage() {
  return (
    <main className="bg-lh-bg text-lh-text">
      <PillNav />
      <Hero />
      <StatsStrip />
      <ThesisParagraph />
      <WhatIsLighthouse />
      <Walkthrough />
      <PrimitivesGrid />
      <FAQ />
      <FooterCard />
    </main>
  )
}
