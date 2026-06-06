import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { MaskReveal } from '@/components/elements/MaskReveal'
import { OnboardingTerminal } from '@/components/landing/terminals/OnboardingTerminal'
import { ProfileTerminal } from '@/components/landing/terminals/ProfileTerminal'
import { TradeTerminal } from '@/components/landing/terminals/TradeTerminal'
import { ArchiveTerminal } from '@/components/landing/terminals/ArchiveTerminal'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const STEPS = [
  {
    index: '01',
    heading: 'Connect in seconds',
    body: 'Sign in with Google via zkLogin. No seed phrase. Enoki covers your first gas.',
    visual: <OnboardingTerminal />,
  },
  {
    index: '02',
    heading: 'Coach learns your style',
    body: 'Answer five questions. Lighthouse builds your risk profile, encrypts it with SEAL, and stores it on Walrus forever.',
    visual: <ProfileTerminal />,
  },
  {
    index: '03',
    heading: 'Trade through a scoped agent wallet',
    body: 'The coach proposes. You confirm. The ExecutorAgent places the order on DeepBook within your pre-set budget, and can never exceed it.',
    visual: <TradeTerminal />,
  },
  {
    index: '04',
    heading: 'Every decision, proof-stored',
    body: 'Recommendations, outcomes, rationale. All archived on Walrus. Shareable. Auditable. Yours to revoke.',
    visual: <ArchiveTerminal />,
  },
] as const

export default function Walkthrough() {
  const sectionRef = useRef<HTMLElement>(null)
  const stepRefs = useRef<Array<HTMLDivElement | null>>([])
  const visualRefs = useRef<Array<HTMLDivElement | null>>([])

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      // Desktop: sticky left labels activated by per-visual ScrollTriggers.
      // No pin, no scrub, no cross-fade. 4 triggers max (combined fade + label).
      mm.add(
        '(min-width: 1024px) and (prefers-reduced-motion: no-preference)',
        () => {
          const activateLabel = (activeIndex: number) => {
            stepRefs.current.forEach((ref, j) => {
              if (!ref) return
              gsap.to(ref, {
                color:
                  j === activeIndex
                    ? 'var(--color-lh-text)'
                    : 'var(--color-lh-text-mute)',
                duration: 0.18,
                ease: 'sui',
              })
            })
          }

          STEPS.forEach((_, i) => {
            const visualEl = visualRefs.current[i]
            if (!visualEl) return

            // One trigger per step: fade-in + label activation combined.
            ScrollTrigger.create({
              trigger: visualEl,
              start: 'top 70%',
              end: 'bottom 35%',
              onEnter: () => {
                gsap.fromTo(
                  visualEl,
                  { autoAlpha: 0, y: 20 },
                  { autoAlpha: 1, y: 0, duration: 0.55, ease: 'power3.out' },
                )
                activateLabel(i)
              },
              onEnterBack: () => activateLabel(i),
            })

            // Set initial state for visuals beyond the first
            if (i > 0) {
              gsap.set(visualEl, { autoAlpha: 0, y: 20 })
            }
          })
        },
      )

      // Mobile: simple stagger entrance, no sticky, single column.
      mm.add(
        '(max-width: 1023px) and (prefers-reduced-motion: no-preference)',
        () => {
          gsap.from('.walkthrough-step', {
            autoAlpha: 0,
            y: 16,
            stagger: 0.1,
            duration: 0.4,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: sectionRef.current,
              start: 'top 70%',
              toggleActions: 'play none none none',
            },
          })
          STEPS.forEach((_, i) => {
            const visualEl = visualRefs.current[i]
            if (!visualEl) return
            gsap.from(visualEl, {
              autoAlpha: 0,
              y: 16,
              duration: 0.4,
              ease: 'power2.out',
              scrollTrigger: {
                trigger: visualEl,
                start: 'top 80%',
                toggleActions: 'play none none none',
              },
            })
          })
        },
      )

      mm.add('(prefers-reduced-motion: reduce)', () => {
        STEPS.forEach((_, i) => {
          const visual = visualRefs.current[i]
          const step = stepRefs.current[i]
          if (visual) gsap.set(visual, { autoAlpha: 1, y: 0 })
          if (step)
            gsap.set(step, {
              color:
                i === 0 ? 'var(--color-lh-text)' : 'var(--color-lh-text-mute)',
            })
        })
        gsap.set('.walkthrough-step', { autoAlpha: 1, y: 0 })
      })
    },
    { scope: sectionRef },
  )

  return (
    <section
      ref={sectionRef}
      aria-label="How Lighthouse works"
      className="relative py-24 md:py-32"
    >
      <div className="max-w-6xl mx-auto px-6">
        {/* H2 is outside the grid — cannot overlap sticky labels */}
        <div className="mb-16">
          <MaskReveal>
            <h2 className="text-4xl md:text-[48px] font-bold leading-[1.1] tracking-[-1px] text-lh-text">
              How it works
            </h2>
          </MaskReveal>
        </div>

        {/*
          Pattern B: sticky left labels, natural-scroll right visuals.
          Section height is content-natural — no min-h-[400vh].
          Visuals render at their natural size — no cross-fade, no absolute stacking.
          The section releases cleanly when its content ends.
        */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-16 lg:gap-24">
          {/* LEFT: sticky label column — sticks 128px from top, hidden on mobile */}
          <div className="hidden lg:block">
            <div className="lg:sticky lg:top-32 space-y-6">
              {STEPS.map((step, i) => (
                <div
                  key={step.index}
                  ref={(el) => {
                    stepRefs.current[i] = el
                  }}
                  className={cnm(
                    'walkthrough-step flex items-start gap-5 transition-colors duration-200',
                  )}
                  style={{
                    color:
                      i === 0
                        ? 'var(--color-lh-text)'
                        : 'var(--color-lh-text-mute)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="font-mono text-3xl leading-none shrink-0 text-lh-accent/30 tabular-nums"
                  >
                    {step.index}
                  </span>
                  <div className="pt-1">
                    <h3 className="text-base font-semibold leading-snug">
                      {step.heading}
                    </h3>
                    <p className="text-sm text-lh-text-dim mt-1 leading-relaxed max-w-[240px]">
                      {step.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT: visuals in natural flow — each gets space-y-[20vh] breathing room */}
          <div className="space-y-[20vh]">
            {STEPS.map((step, i) => (
              <div key={step.index}>
                {/* Mobile-only label (lg:hidden) */}
                <div
                  className={cnm(
                    'walkthrough-step lg:hidden mb-6 flex items-start gap-5',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="font-mono text-3xl leading-none shrink-0 text-lh-accent/30 tabular-nums"
                  >
                    {step.index}
                  </span>
                  <div className="pt-1">
                    <h3 className="text-base font-semibold leading-snug text-lh-text">
                      {step.heading}
                    </h3>
                    <p className="text-sm text-lh-text-dim mt-1 leading-relaxed">
                      {step.body}
                    </p>
                  </div>
                </div>

                {/* Visual */}
                <div
                  ref={(el) => {
                    visualRefs.current[i] = el
                  }}
                  aria-label={`Visual for step ${step.index}: ${step.heading}`}
                  className="flex flex-col justify-center min-h-[80vh] py-12"
                >
                  <p
                    aria-hidden="true"
                    className="font-mono text-[10px] uppercase tracking-[0.18em] text-lh-text-mute mb-3 leading-none"
                  >
                    {step.index} /
                  </p>
                  {step.visual}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
