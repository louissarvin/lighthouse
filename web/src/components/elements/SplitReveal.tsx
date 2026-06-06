import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

gsap.registerPlugin(ScrollTrigger)

// SplitReveal - per-line wipe reveal inside overflow-hidden containers.
//
// Technique: sui.io / overflow.sui.io (BATCH2_TECH_SUMMARY Rank 1).
//
// SSR strategy: text renders VISIBLE by default. GSAP uses gsap.from() to
// animate from yPercent: 100 (hidden) to the natural rendered state. If JS
// fails to run, text remains visible - graceful degradation, never FOUC-to-hidden.
//
// When immediate=true: skip ScrollTrigger and animate on mount. Use for
// above-the-fold content (hero) where the element is always in view.
//
// Reduced motion: skip animation entirely, text shows at natural position.

export interface SplitRevealProps {
  lines: ReadonlyArray<ReactNode>
  className?: string
  lineClassName?: string
  stagger?: number
  delay?: number
  start?: string
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'div'
  immediate?: boolean
}

export function SplitReveal({
  lines,
  className,
  lineClassName,
  stagger = 0.08,
  delay = 0,
  start = 'top 78%',
  as: Tag = 'div',
  immediate = false,
}: SplitRevealProps) {
  const scopeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scope = scopeRef.current
    if (!scope) return

    const inners = Array.from(
      scope.querySelectorAll<HTMLElement>('.split-line-inner'),
    )
    if (inners.length === 0) return

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (prefersReduced) return // text already visible at natural position

    const tweenVars: gsap.TweenVars = {
      yPercent: 100,
      stagger,
      delay,
      duration: 0.525,
      ease: 'sui',
      overwrite: 'auto',
    }

    if (!immediate) {
      tweenVars.scrollTrigger = {
        trigger: scope,
        start,
        once: true,
      }
    }

    // gsap.from: snapshot current (natural) state as the destination, animate
    // FROM yPercent: 100. Text is already rendered at the destination, so
    // there is a one-frame flash before GSAP grabs it. Acceptable trade-off
    // for guaranteed visibility if anything in the animation pipeline fails.
    const tween = gsap.from(inners, tweenVars)

    return () => {
      tween.scrollTrigger?.kill()
      tween.kill()
    }
  }, [immediate, stagger, delay, start])

  return (
    <div ref={scopeRef}>
      <Tag className={className}>
        {lines.map((line, i) => (
          <div key={i} className={cnm('overflow-hidden', lineClassName)}>
            <div className="split-line-inner">{line}</div>
          </div>
        ))}
      </Tag>
    </div>
  )
}
