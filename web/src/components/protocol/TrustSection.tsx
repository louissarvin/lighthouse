import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { TrustCard } from '@/components/protocol/TrustCard'
import { Github } from '@/constants/icons'

const TRUST_CARDS = [
  {
    status: 'testnet' as const,
    label: 'Deployment status',
    body: 'Move package deployed to Sui mainnet on Day 21. Walrus blobs persist on mainnet. DeepBook v3 spot trades use mainnet. DeepBook Predict hedge is testnet-only (Predict mainnet ships later 2026).',
  },
  {
    status: 'pending' as const,
    label: 'Smart contract audit',
    body: 'Audit not yet completed. The lighthouse::executor and lighthouse::trader_profile contracts contain budget enforcement and SEAL policy logic that should be reviewed by an independent party before significant funds are committed.',
  },
  {
    status: 'live' as const,
    label: 'Source code',
    body: 'The Lighthouse Move package and TypeScript backend are open source. All SEAL seal_approve entry points are visible and reviewable. The audit_anchor module creates a verifiable on-chain trail of every decision.',
  },
  {
    status: 'warning' as const,
    label: 'SEAL past-decryption caveat',
    body: 'Once a copy-trader calls fetchKeys during their grant window, they hold the derived decryption key. Revoking the grant blocks future key requests but does not retract data already decrypted. Treat any shared slice as permanently disclosed to that party after successful decryption.',
  },
]

export function TrustSection() {
  return (
    <section
      aria-labelledby="trust-h2"
      className="py-24 md:py-32 bg-lh-bg-elev border-y border-lh-line"
    >
      <Container>
        <EyebrowTag dot className="mb-6">
          Audits + status
        </EyebrowTag>
        <MaskReveal className="mb-4">
          <h2
            id="trust-h2"
            className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text max-w-xl"
          >
            Honest about where we are.
          </h2>
        </MaskReveal>
        <p className="text-base text-lh-text-dim leading-[1.65] max-w-2xl mb-12">
          Lighthouse was built during Sui Overflow 2026 in a three-week sprint.
          The Move contracts are new, the MemWal integration is on a beta
          relayer, and SEAL key servers on testnet have no published SLA. We are
          being specific about this because you deserve to know.
        </p>

        <AnimateComponent
          onScroll
          entry="fadeInUp"
          duration={550}
          threshold={0.15}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
            {TRUST_CARDS.map((card) => (
              <TrustCard
                key={card.label}
                status={card.status}
                label={card.label}
                body={card.body}
              />
            ))}
          </div>
        </AnimateComponent>

        <div className="flex flex-wrap gap-6">
          <a
            href="https://github.com/lighthouse-sui"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-mono text-lh-text-dim hover:text-lh-text transition-colors duration-150 uppercase tracking-[0.12em]"
          >
            <Github size={14} strokeWidth={1.5} aria-hidden="true" />
            GitHub
          </a>
          <span className="inline-flex items-center gap-2 text-sm font-mono text-lh-text-mute uppercase tracking-[0.12em]">
            Contract pending mainnet deploy
          </span>
        </div>
      </Container>
    </section>
  )
}
