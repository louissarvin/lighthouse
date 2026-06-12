import { useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { ArrowRight } from '@/constants/icons'

gsap.registerPlugin(useGSAP)

export function ProtocolHero() {
  const sectionRef = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()

  useGSAP(
    () => {
      if (reduced) {
        gsap.set(['.proto-eyebrow', '.proto-h1', '.proto-body', '.proto-cta'], {
          autoAlpha: 1,
          y: 0,
        })
        return
      }

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap
          .timeline({ defaults: { ease: 'power3.out', duration: 0.55 } })
          .fromTo(
            '.proto-eyebrow',
            { autoAlpha: 0, y: 12 },
            { autoAlpha: 1, y: 0 },
          )
          .fromTo(
            '.proto-h1',
            { autoAlpha: 0, y: 20 },
            { autoAlpha: 1, y: 0 },
            '-=0.47',
          )
          .fromTo(
            '.proto-body',
            { autoAlpha: 0, y: 16 },
            { autoAlpha: 1, y: 0 },
            '-=0.47',
          )
          .fromTo(
            '.proto-cta',
            { autoAlpha: 0, y: 8 },
            { autoAlpha: 1, y: 0 },
            '-=0.47',
          )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(['.proto-eyebrow', '.proto-h1', '.proto-body', '.proto-cta'], {
          autoAlpha: 1,
          y: 0,
        })
      })
    },
    { scope: sectionRef },
  )

  return (
    <section
      ref={sectionRef}
      aria-labelledby="protocol-hero-h1"
      className="py-32 md:py-40 bg-lh-bg"
    >
      <Container size="narrow">
        <div className="proto-eyebrow mb-6">
          <EyebrowTag dot>Protocol Architecture</EyebrowTag>
        </div>

        <h1
          id="protocol-hero-h1"
          className="proto-h1 font-bold text-[40px] md:text-[64px] xl:text-[88px] leading-[0.97] tracking-[-0.03em] text-lh-text mb-6"
        >
          Five layers of infrastructure
          <br />
          <span className="text-lh-text-dim">for AI that trades honestly.</span>
        </h1>

        <p className="proto-body text-base text-lh-text-dim leading-relaxed max-w-[560px] mb-10">
          Lighthouse is not a chatbot wrapper. It is a stack of Sui-native
          primitives wired together to make an AI trading coach verifiable,
          auditable, and revocable.
        </p>

        <div className="proto-cta">
          <a
            href="/docs"
            className="inline-flex items-center gap-2 text-sm font-semibold text-lh-text-dim hover:text-lh-text transition-colors duration-150 relative after:absolute after:bottom-0 after:left-0 after:h-px after:w-0 after:bg-lh-accent-warm after:transition-[width] after:duration-200 hover:after:w-full"
          >
            Read the docs
            <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </div>
      </Container>
    </section>
  )
}
