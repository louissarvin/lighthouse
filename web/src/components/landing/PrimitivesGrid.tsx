import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { Card } from '@/components/ui/Card'
import { MaskReveal } from '@/components/elements/MaskReveal'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { ArrowLeft, ArrowRight } from '@/constants/icons'

gsap.registerPlugin(ScrollTrigger, useGSAP)

type HoverSide = 'left' | 'right' | null

const CARDS = [
  {
    metric: '7',
    metricLabel: 'Memory namespaces',
    glyph: '▸',
    eyebrow: 'Memory layer',
    title: 'MemWal namespaces',
    body: 'Your coaching history lives in a structured namespace on Walrus. Every session reads from the same source of truth. Cross-device, cross-session, forever.',
  },
  {
    metric: '3 / 5',
    metricLabel: 'Shares required',
    glyph: '◈',
    eyebrow: 'Access control',
    title: 'SEAL threshold encryption',
    body: 'Your risk profile is encrypted at rest. You control who reads it. Grant a copy-trader access for 30 days. Revoke in one transaction.',
  },
  {
    metric: '5',
    metricLabel: 'Budget assertions',
    glyph: '◉',
    eyebrow: 'Execution layer',
    title: 'Capability-scoped wallets',
    body: 'The ExecutorAgent can place orders up to your budget on whitelisted pools. It cannot deposit, withdraw, or exceed its mandate. Ever.',
  },
  {
    metric: '53',
    metricLabel: 'Epoch retention',
    glyph: '◎',
    eyebrow: 'Audit layer',
    title: 'Walrus persistence',
    body: 'Every recommendation and its outcome is archived as a Walrus blob. Shareable tearsheets. Verifiable rationale. An audit trail that outlives the app.',
  },
] as const

export default function PrimitivesGrid() {
  const sectionRef = useRef<HTMLElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const metricRefs = useRef<Array<HTMLDivElement | null>>([])
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)
  const [hoverSide, setHoverSide] = useState<HoverSide>(null)
  // Track which button (if any) currently holds keyboard focus so we can
  // reveal it regardless of mouse position.
  const [focusedButton, setFocusedButton] = useState<'left' | 'right' | null>(
    null,
  )

  const updateScrollState = () => {
    const el = scrollerRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 8)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 8)
  }

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return

    updateScrollState()
    el.addEventListener('scroll', updateScrollState, { passive: true })
    window.addEventListener('resize', updateScrollState, { passive: true })

    return () => {
      el.removeEventListener('scroll', updateScrollState)
      window.removeEventListener('resize', updateScrollState)
    }
  }, [])

  const getCardWidth = (): number => {
    const el = scrollerRef.current
    if (!el) return 424
    const firstCard = el.querySelector('.primitives-card')
    if (!firstCard) return 424
    return firstCard.getBoundingClientRect().width + 24
  }

  const scrollLeft = () => {
    const el = scrollerRef.current
    if (!el) return
    const cardWidth = getCardWidth()
    el.scrollBy({
      left: -cardWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }

  const scrollRight = () => {
    const el = scrollerRef.current
    if (!el) return
    const cardWidth = getCardWidth()
    el.scrollBy({
      left: cardWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }

  const handleCarouselMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const w = rect.width
    if (x < w * 0.33) setHoverSide('left')
    else if (x > w * 0.67) setHoverSide('right')
    else setHoverSide(null)
  }

  const handleCarouselMouseLeave = () => setHoverSide(null)

  // Derived visibility: mouse-zone OR keyboard focus on that button.
  const leftVisible =
    (hoverSide === 'left' || focusedButton === 'left') && canScrollLeft
  const rightVisible =
    (hoverSide === 'right' || focusedButton === 'right') && canScrollRight

  // Card stagger entrance + metric count-up on scroll enter.
  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const cards =
          scrollerRef.current?.querySelectorAll<HTMLElement>('.primitives-card')
        if (!cards?.length) return

        // Stagger entrance: y: 24 -> 0, autoAlpha: 0 -> 1
        gsap.fromTo(
          cards,
          { y: 24, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.55,
            stagger: 0.1,
            ease: 'sui',
            scrollTrigger: {
              trigger: sectionRef.current,
              start: 'top 78%',
              once: true,
            },
          },
        )

        // Count-up on each metric number.
        // Mirrors StatsStrip Phase 2 exactly: proxy object { val: 0 }, snap, onUpdate writes textContent.
        CARDS.forEach((card, i) => {
          const el = metricRefs.current[i]
          if (!el) return

          const targetStr = el.dataset.metricTarget
          const suffix = el.dataset.metricSuffix ?? ''
          const target = parseFloat(targetStr ?? '0')
          if (isNaN(target)) return

          const obj = { val: 0 }
          gsap.to(obj, {
            val: target,
            duration: 1.2,
            ease: 'power3.out',
            snap: { val: 1 },
            onUpdate() {
              el.textContent = String(Math.round(obj.val)) + suffix
            },
            onComplete() {
              // Restore the full original metric text (e.g. "3 / 5")
              el.textContent = card.metric
            },
            scrollTrigger: {
              trigger: sectionRef.current,
              start: 'top 78%',
              once: true,
            },
          })
        })
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        const cards =
          scrollerRef.current?.querySelectorAll<HTMLElement>('.primitives-card')
        cards?.forEach((el) => gsap.set(el, { autoAlpha: 1, y: 0 }))

        // Write final values directly — no animation.
        CARDS.forEach((card, i) => {
          const el = metricRefs.current[i]
          if (el) el.textContent = card.metric
        })
      })
    },
    { scope: sectionRef },
  )

  return (
    <section
      ref={sectionRef}
      aria-label="Protocol primitives"
      className="py-24 md:py-32"
    >
      <div className="max-w-6xl mx-auto px-6">
        <div className="mb-14">
          <EyebrowTag className="mb-4">Built on</EyebrowTag>
          <MaskReveal>
            <h2 className="text-4xl md:text-[48px] font-bold leading-[1.1] tracking-[-1px] text-lh-text max-w-xl">
              Four primitives.{' '}
              <span className="text-lh-text-dim">One coherent system.</span>
            </h2>
          </MaskReveal>
        </div>

        {/* Scroll-snap carousel — contained to the same max-w-6xl as the heading (pivy-style) */}
        <div
          className="lh-cards-scroller relative"
          onMouseMove={handleCarouselMouseMove}
          onMouseLeave={handleCarouselMouseLeave}
        >
          {/* Right edge fade hints "more cards exist, swipe to see" */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-24 z-10"
            style={{
              background:
                'linear-gradient(to left, var(--color-lh-bg) 0%, transparent 100%)',
            }}
          />

          {/* Left navigation arrow — visible only when cursor is in left zone or button is focused */}
          <button
            type="button"
            onClick={scrollLeft}
            aria-label="Scroll to previous cards"
            onFocus={() => setFocusedButton('left')}
            onBlur={() => setFocusedButton(null)}
            tabIndex={canScrollLeft ? 0 : -1}
            className={cnm(
              'absolute top-1/2 -translate-y-1/2 left-6 z-20',
              'w-12 h-12 rounded-full',
              'bg-lh-bg',
              'shadow-[0_4px_16px_rgb(0_0_0/0.12)]',
              'dark:bg-lh-bg-elev dark:shadow-[0_4px_16px_rgb(0_0_0/0.5)]',
              'border border-lh-line',
              'flex items-center justify-center',
              'text-lh-text-dim hover:text-lh-text',
              'transition-opacity duration-200',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
              leftVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
          >
            <ArrowLeft size={20} strokeWidth={1.5} />
          </button>

          {/* Right navigation arrow — visible only when cursor is in right zone or button is focused */}
          <button
            type="button"
            onClick={scrollRight}
            aria-label="Scroll to next cards"
            onFocus={() => setFocusedButton('right')}
            onBlur={() => setFocusedButton(null)}
            tabIndex={canScrollRight ? 0 : -1}
            className={cnm(
              'absolute top-1/2 -translate-y-1/2 right-6 z-20',
              'w-12 h-12 rounded-full',
              'bg-lh-bg',
              'shadow-[0_4px_16px_rgb(0_0_0/0.12)]',
              'dark:bg-lh-bg-elev dark:shadow-[0_4px_16px_rgb(0_0_0/0.5)]',
              'border border-lh-line',
              'flex items-center justify-center',
              'text-lh-text-dim hover:text-lh-text',
              'transition-opacity duration-200',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
              rightVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
          >
            <ArrowRight size={20} strokeWidth={1.5} />
          </button>

          <div
            ref={scrollerRef}
            className="lh-cards-track flex items-stretch gap-4 overflow-x-auto snap-x snap-mandatory scroll-px-0 pb-4"
          >
            {CARDS.map((card, i) => (
              <Card
                key={card.title}
                as="article"
                // Override base Card shadow with none; only the amber hairline
                // inset shadow shows on hover. Layout-free, no shift on hover.
                // Transition: dur-fast (0.18s) at ease-sui for the Sui house feel.
                className={cnm(
                  'primitives-card snap-start shrink-0 w-[80vw] sm:w-[320px] relative',
                  'shadow-none dark:shadow-none',
                  'transition-shadow duration-[0.18s] ease-[var(--ease-sui)]',
                  'hover:shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]',
                )}
                style={{ opacity: 0 }}
              >
                <div className="mb-6 pb-6 border-b border-lh-line">
                  <div
                    ref={(el) => {
                      metricRefs.current[i] = el
                    }}
                    aria-hidden="true"
                    data-metric-target={
                      card.metric.includes(' / ')
                        ? card.metric.split(' / ')[0]
                        : card.metric
                    }
                    data-metric-suffix={
                      card.metric.includes(' / ')
                        ? ' / ' + card.metric.split(' / ')[1]
                        : ''
                    }
                    className="card-metric font-mono text-[44px] leading-none tracking-tight tabular-nums text-lh-text-mute/30"
                  >
                    {card.metric}
                  </div>
                  <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute">
                    {card.metricLabel}
                  </div>
                </div>

                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
                  {card.eyebrow}
                </p>

                <h3 className="text-xl font-semibold leading-[1.2] tracking-[-0.5px] text-lh-text mb-3">
                  {card.title}
                </h3>

                <p className="text-sm text-lh-text-dim leading-relaxed">
                  {card.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
