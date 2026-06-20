import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// SplitReveal - per-line wipe reveal inside overflow-hidden containers.
//
// Technique: sui.io / overflow.sui.io (BATCH2_TECH_SUMMARY Rank 1).
//
// SSR strategy: text renders VISIBLE by default. GSAP uses fromTo() to
// animate from yPercent: 100 (hidden) to yPercent: 0 (natural). If JS
// fails to run, text remains visible - graceful degradation, never FOUC-to-hidden.
//
// Why fromTo and not from: gsap.from() snapshots current position as the
// destination. Under React Strict Mode the effect runs twice; the cleanup
// between runs kills the in-flight tween while the element is still at
// yPercent: 100, and the second run then reads 100 as the natural position,
// permanently clipping the text. fromTo() is idempotent - explicit start
// AND end values survive any number of remounts.
//
// useGSAP from @gsap/react handles the React lifecycle and cleanup correctly,
// matching the pattern used elsewhere in the codebase (Hero, PrimitivesGrid,
// StatsStrip, WhatIsLighthouse).
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

  useGSAP(
    () => {
      const scope = scopeRef.current
      if (!scope) return

      const inners = Array.from(
        scope.querySelectorAll<HTMLElement>('.split-line-inner'),
      )
      if (inners.length === 0) return

      const prefersReduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches

      if (prefersReduced) {
        // Ensure final state in case a prior tween left things mid-flight.
        gsap.set(inners, { yPercent: 0, clearProps: 'transform' })
        return
      }

      const tweenVars: gsap.TweenVars = {
        yPercent: 0,
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

      // Explicit start (yPercent: 100) AND end (yPercent: 0) makes the tween
      // safe against Strict Mode double-invocation and any remount cycle.
      gsap.fromTo(inners, { yPercent: 100 }, tweenVars)
    },
    { scope: scopeRef, dependencies: [immediate, stagger, delay, start] },
  )

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
