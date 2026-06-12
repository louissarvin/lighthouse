import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { ArrowRight } from '@/constants/icons'
import { GridBackdrop } from '@/components/elements/GridBackdrop'

const CODE = `// Recall the top-5 most relevant memories
// before generating a recommendation
const recalled = await memwal.recall({
  query: "User's typical USDC position size on SUI longs",
  limit: 5,
});

// recalled.results: RecallMemory[]
// Each: { blob_id, text, distance }
// Lower distance = more similar`

export function LayerMemoryMemWal() {
  return (
    <section
      aria-labelledby="layer-memwal-h2"
      className="relative py-16 md:py-24 border-t border-lh-line bg-lh-bg"
    >
      <GridBackdrop opacity={0.03} />
      <Container>
        <AnimateComponent
          onScroll
          entry="fadeInUp"
          duration={550}
          threshold={0.15}
        >
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-12 lg:gap-20 items-start">
            {/* Left: text */}
            <div>
              <EyebrowTag className="mb-4">03 / Memory</EyebrowTag>
              <MaskReveal className="mb-6">
                <h2
                  id="layer-memwal-h2"
                  className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text"
                >
                  The coach reads your history before every recommendation.
                </h2>
              </MaskReveal>
              <div className="space-y-4 text-base text-lh-text-dim leading-relaxed">
                <p>
                  Lighthouse maintains seven named memory namespaces on Walrus
                  via MemWal. Each namespace is a semantic category: risk
                  profile, trade history, lessons learned, goals, holdings
                  snapshots, coach personality calibration, and UI preferences.
                  Every coaching session starts with a vector-similarity recall
                  across the relevant namespaces, pulling the most relevant
                  memories into the Atoma prompt context.
                </p>
                <p>
                  MemWal namespaces are flat opaque strings —{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    lighthouse:trades
                  </code>{' '}
                  is a naming convention, not a hierarchy. Recall matches a
                  single namespace per call, so a full cross-session context
                  lookup issues seven parallel signed calls. The results are
                  scored by semantic distance and recency, then injected into
                  the system prompt. Your trading edge does not reset when you
                  close the browser.
                </p>
              </div>
              <a
                href="/docs/walrus-integration"
                className="mt-8 inline-flex items-center gap-2 text-sm text-lh-accent-warm font-mono uppercase tracking-[0.12em] hover:gap-3 transition-all duration-150"
              >
                MemWal integration guide
                <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
              </a>
            </div>

            {/* Right: code panel */}
            <div className="bg-lh-bg-elev border border-lh-line rounded-2xl overflow-hidden">
              <div className="border-b border-lh-line px-5 py-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
                  TypeScript
                </span>
              </div>
              <pre className="p-6 overflow-x-auto">
                <code className="font-mono text-[13px] leading-[1.6] text-lh-text-dim whitespace-pre">
                  {CODE}
                </code>
              </pre>
            </div>
          </div>
        </AnimateComponent>
      </Container>
    </section>
  )
}
