import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { CustomEase } from 'gsap/CustomEase'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'

gsap.registerPlugin(ScrollTrigger, CustomEase, useGSAP)

// Accordion easing curve, extracted from Pivy.me FAQ via Playwright probe.
// cubic-bezier(0.04, 0.62, 0.23, 0.98) - slow start (content does not "jump"),
// decisive middle, gentle deceleration into rest. Specifically tuned for
// height-from-zero accordion reveals. Documented in
// memory/research/ui-references/tech/faq-animation-deep.md.
CustomEase.create('faqAccordion', '0.04, 0.62, 0.23, 0.98')

// FAQ - single-open accordion with cross-fade close+open on the same GSAP
// timeline. Mirrors the landing rhythm: max-w-6xl container, 2-col header
// (heading left, description right, like WhatIsLighthouse), question stack
// spans the full width below.
//
// Animation: when the user opens a different item, the previously open answer
// collapses (height to 0, opacity to 0) in PARALLEL with the new answer
// expanding (height from 0 to auto, opacity 0 to 1). Both tweens start at
// time 0 of the same timeline, so the user perceives a smooth swap rather
// than two sequential animations.
//
// Accessibility: <button aria-expanded aria-controls> drives a region. The
// answer text is in DOM at all times (visible by SSR fallback opacity 0,
// height 0 inline style) so screen readers can navigate it.

const FAQS = [
  {
    q: 'What does Lighthouse actually do?',
    a: 'Lighthouse is an AI trading coach with verifiable memory. You describe what you want in plain English, it plans the trade, sizes the risk, and executes on DeepBook within a budget you set. Every decision is stored on Walrus so you and the agent share one source of truth across sessions and devices.',
  },
  {
    q: 'Who custodies my funds?',
    a: 'You do. Lighthouse never takes custody. The ExecutorAgent operates a capability-scoped wallet that can place orders inside your defined budget and on whitelisted pools only. It cannot deposit, withdraw, or exceed the assertions you signed.',
  },
  {
    q: 'How is my data protected?',
    a: 'Your risk profile and coaching history are encrypted at rest using SEAL threshold encryption. Access is granular and revocable in a single Sui transaction. You can grant a copy-trader read access for 30 days and rescind it at any time.',
  },
  {
    q: 'Where does the memory live?',
    a: 'On Walrus. Every recommendation, outcome, and lesson is written to a structured namespace on Walrus storage. The data persists across epochs, is verifiable, and outlives any single app or device. Your trading edge is portable.',
  },
  {
    q: 'What chains and venues are supported?',
    a: 'Mainnet on Sui at launch. Execution is routed through DeepBook for spot pairs. Additional venues and chains follow as the executor capability set expands. The whitelist is published and auditable on-chain.',
  },
  {
    q: 'Do I need to hold SUI to use it?',
    a: 'You need SUI for gas, the same as any Sui application. There is no Lighthouse token. The protocol is gas-only.',
  },
  {
    q: 'Can I revoke the agent at any time?',
    a: 'Yes. The capability that authorizes the ExecutorAgent is a Sui object you own. Burning it or transferring it terminates every action the agent can take in one transaction.',
  },
  {
    q: 'Is the code open source?',
    a: 'The protocol contracts and the SDK ship open source under permissive license. Audit reports and reproducible builds are published before each mainnet release.',
  },
] as const

export default function FAQ() {
  const sectionRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const answerRefs = useRef<Array<HTMLDivElement | null>>([])
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // SSR-safe initial state: every answer renders with height 0 and opacity 0
  // inline (set in JSX). On mount, that is the same state JS expects. The
  // useEffect below is a defensive set in case any answer was somehow
  // pre-expanded by the browser before hydration completed.
  useEffect(() => {
    answerRefs.current.forEach((el, i) => {
      if (!el) return
      if (i !== openIndex) {
        gsap.set(el, { height: 0, opacity: 0, overflow: 'hidden' })
      }
    })
  }, [openIndex])

  // Section entrance stagger - mirrors WhatIsLighthouse card pattern.
  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>('.faq-row')
        if (!rows?.length) return

        gsap.fromTo(
          rows,
          { y: 20, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.55,
            stagger: 0.06,
            ease: 'sui',
            scrollTrigger: {
              trigger: listRef.current,
              start: 'top 78%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>('.faq-row')
        rows?.forEach((el) => gsap.set(el, { autoAlpha: 1, y: 0 }))
      })
    },
    { scope: sectionRef },
  )

  const handleClick = (index: number) => {
    const prev = openIndex
    const next = prev === index ? null : index

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduce) {
      // No animation. Just set state; CSS holds final heights via inline
      // style applied through the answer ref below.
      if (prev !== null && prev !== next) {
        const prevEl = answerRefs.current[prev]
        if (prevEl) gsap.set(prevEl, { height: 0, opacity: 0 })
      }
      if (next !== null) {
        const nextEl = answerRefs.current[next]
        if (nextEl)
          gsap.set(nextEl, {
            height: 'auto',
            opacity: 1,
            overflow: 'visible',
          })
      }
      setOpenIndex(next)
      return
    }

    // PARALLEL timeline matching the proven Velfi + Pivy pattern (research
    // in memory/research/ui-references/tech/faq-animation-deep.md). Close and
    // open both start at position 0 of the same timeline, so the user sees
    // one continuous swap rather than two discrete animations. Pivy's
    // ResizeObserver log: 0ms gap between close start and open start, 396ms
    // total swap. Matching duration and easing on both sides creates the
    // visual symmetry that reads as "smooth."
    const DURATION = 0.4
    const EASE = 'faqAccordion'

    const tl = gsap.timeline()

    // Close the previously open item (if any, and not the same item the
    // user just clicked).
    if (prev !== null && prev !== next) {
      const prevEl = answerRefs.current[prev]
      if (prevEl) {
        tl.to(
          prevEl,
          {
            height: 0,
            opacity: 0,
            overflow: 'hidden',
            duration: DURATION,
            ease: EASE,
          },
          0, // start at frame 0 - parallel
        )
      }
    } else if (prev !== null && next === null) {
      // User clicked the same open item to close it. Solo close, no parallel.
      const prevEl = answerRefs.current[prev]
      if (prevEl) {
        tl.to(prevEl, {
          height: 0,
          opacity: 0,
          overflow: 'hidden',
          duration: DURATION,
          ease: EASE,
        })
      }
    }

    // Open the newly clicked item at position 0 - parallel with the close.
    if (next !== null) {
      const nextEl = answerRefs.current[next]
      if (nextEl) {
        tl.fromTo(
          nextEl,
          { height: 0, opacity: 0, overflow: 'hidden' },
          {
            height: 'auto',
            opacity: 1,
            overflow: 'visible',
            duration: DURATION,
            ease: EASE,
          },
          0, // start at frame 0 - parallel with the close tween above
        )
      }
    }

    setOpenIndex(next)
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Frequently asked questions"
      className="py-24 md:py-32"
    >
      <div className="max-w-6xl mx-auto px-6">
        <div className="mb-12 lg:mb-14">
          <EyebrowTag className="mb-4">FAQ</EyebrowTag>
          <MaskReveal>
            <h2 className="text-4xl md:text-[48px] font-bold leading-[1.1] tracking-[-1px] text-lh-text">
              Questions, <span className="text-lh-text-dim">answered.</span>
            </h2>
          </MaskReveal>
        </div>

        {/* Question stack at full container width to match landing layout */}
        <div ref={listRef}>
          {FAQS.map((item, i) => {
            const isOpen = openIndex === i
            const answerId = `faq-answer-${i}`
            const buttonId = `faq-button-${i}`

            return (
              <div
                key={item.q}
                className="faq-row border-b border-lh-line"
                style={{ opacity: 0 }}
              >
                <h3>
                  <button
                    id={buttonId}
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={answerId}
                    onClick={() => handleClick(i)}
                    className={cnm(
                      'w-full flex items-center justify-between gap-6 py-6 text-left',
                      'cursor-pointer select-none',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring rounded-sm',
                      'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-sui)]',
                    )}
                  >
                    <span
                      className={cnm(
                        'font-semibold text-[18px] md:text-[20px] leading-[1.3] tracking-[-0.3px]',
                        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-sui)]',
                        isOpen ? 'text-lh-text' : 'text-lh-text',
                      )}
                    >
                      {item.q}
                    </span>
                    {/* Plus icon rotates 45deg to x on open. Driven by
                        data-open attribute instead of <details[open]> since
                        we drive state manually now. */}
                    <span
                      aria-hidden="true"
                      data-open={isOpen}
                      className={cnm(
                        'shrink-0 w-6 h-6 flex items-center justify-center text-lh-accent',
                        'transition-transform duration-[0.4s] ease-[cubic-bezier(0.04,0.62,0.23,0.98)]',
                        'data-[open=true]:rotate-45',
                      )}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <line
                          x1="8"
                          y1="1"
                          x2="8"
                          y2="15"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                        <line
                          x1="1"
                          y1="8"
                          x2="15"
                          y2="8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                  </button>
                </h3>

                <div
                  ref={(el) => {
                    answerRefs.current[i] = el
                  }}
                  id={answerId}
                  role="region"
                  aria-labelledby={buttonId}
                  // SSR pre-state: collapsed by default. JS animates on click.
                  style={{ height: 0, opacity: 0, overflow: 'hidden' }}
                >
                  <p className="text-[15px] md:text-[16px] text-lh-text-dim leading-[1.7] pb-6 max-w-3xl">
                    {item.a}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
