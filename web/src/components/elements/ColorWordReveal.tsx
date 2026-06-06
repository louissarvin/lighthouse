import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// ColorWordReveal — color-based word reveal on scroll.
//
// Technique: tmrw.finance (tmrw.md §Word-Reveal Technique).
// Each word starts at `fromColor` (muted) and transitions to `toColor` (full)
// as scroll passes the word's midpoint. tmrw uses a vanilla scroll listener;
// here we use GSAP ScrollTrigger scrub so it integrates with Lenis.
//
// Mechanism choice: one scrubbed master tween that updates CSS color per word
// via a single ScrollTrigger with stagger. This is closer to tmrw's continuous
// feel than per-word individual triggers (which can batch awkwardly with Lenis).
//
// SSR pre-state: words render at fromColor via inline style. The animation
// only modifies color after JS hydrates, so there is no FOUC.
//
// Reduced motion: all words are immediately set to toColor, no animation.

export interface ColorWordRevealProps {
  children: string
  className?: string
  pace?: 'slow' | 'normal' | 'fast'
  fromColor?: string
  toColor?: string
  stagger?: number
}

const paceEndMap = {
  slow: 'bottom 20%',
  normal: 'bottom 35%',
  fast: 'bottom 55%',
} as const

export function ColorWordReveal({
  children,
  className,
  pace = 'normal',
  fromColor = 'var(--color-lh-text-mute)',
  toColor = 'var(--color-lh-text)',
  stagger = 0.04,
}: ColorWordRevealProps) {
  const containerRef = useRef<HTMLParagraphElement>(null)

  useGSAP(
    () => {
      const container = containerRef.current
      if (!container) return

      const words = container.querySelectorAll<HTMLElement>('[data-cw]')

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          words,
          { color: fromColor },
          {
            color: toColor,
            stagger,
            ease: 'none',
            scrollTrigger: {
              trigger: container,
              scrub: 1,
              start: 'top 80%',
              end: paceEndMap[pace],
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        words.forEach((w) => {
          w.style.color = toColor
        })
      })
    },
    { scope: containerRef },
  )

  const wordList = children.split(' ')

  return (
    <p ref={containerRef} className={className} aria-label={children}>
      {wordList.map((word, i) => (
        <span
          key={i}
          data-cw={word}
          // Inline style sets the pre-hydration fromColor so SSR output matches
          // the animation start state. No FOUC.
          style={{ color: fromColor, transition: 'color 0.08s linear' }}
          aria-hidden="true"
        >
          {word}
          {i < wordList.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}
