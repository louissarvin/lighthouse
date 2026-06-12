import { createFileRoute } from '@tanstack/react-router'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'
import { ProtocolHero } from '@/components/protocol/ProtocolHero'
import { ArchitectureDiagram } from '@/components/protocol/ArchitectureDiagram'
import { LayerStorageWalrus } from '@/components/protocol/layers/LayerStorageWalrus'
import { LayerAccessControlSEAL } from '@/components/protocol/layers/LayerAccessControlSEAL'
import { LayerMemoryMemWal } from '@/components/protocol/layers/LayerMemoryMemWal'
import { LayerExecutionAgent } from '@/components/protocol/layers/LayerExecutionAgent'
import { LayerInferenceAtoma } from '@/components/protocol/layers/LayerInferenceAtoma'
import { TrustSection } from '@/components/protocol/TrustSection'

export const Route = createFileRoute('/protocol')({
  component: ProtocolPage,
  head: () => ({
    meta: [
      { title: 'Protocol Architecture | Lighthouse' },
      {
        name: 'description',
        content:
          'Five layers of Sui-native infrastructure for verifiable AI trading: Walrus storage, SEAL access control, MemWal memory, capability-scoped execution, and Atoma inference.',
      },
    ],
  }),
})

function ProtocolPage() {
  return (
    <main className="bg-lh-bg text-lh-text">
      <PillNav />
      <ProtocolHero />
      <ArchitectureDiagram />
      <LayerStorageWalrus />
      <LayerAccessControlSEAL />
      <LayerMemoryMemWal />
      <LayerExecutionAgent />
      <LayerInferenceAtoma />
      <TrustSection />
      <FooterCard />
    </main>
  )
}
