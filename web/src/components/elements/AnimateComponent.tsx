import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'

gsap.registerPlugin(ScrollTrigger, useGSAP)

type EntryAnimation =
  | 'fadeIn'
  | 'fadeInUp'
  | 'fadeInDown'
  | 'fadeInLeft'
  | 'fadeInRight'
  | 'scaleIn'
  | 'slideUp'

type ExitAnimation =
  | 'fadeOut'
  | 'fadeOutUp'
  | 'fadeOutDown'
  | 'fadeOutLeft'
  | 'fadeOutRight'
  | 'scaleOut'
  | 'slideDown'

interface AnimateComponentProps {
  entry?: EntryAnimation
  exit?: ExitAnimation
  ease?: string
  duration?: number
  delay?: number
  className?: string
  children: React.ReactNode
  onScroll?: boolean
  threshold?: number
  rootMargin?: string
  resetOnLeave?: boolean
  stagger?: boolean
  staggerDelay?: number
}

export default function AnimateComponent({
  entry = 'fadeInUp',
  exit = 'fadeOutDown',
  ease = 'sui',
  duration = 525,
  delay = 0,
  className,
  children,
  onScroll = false,
  threshold = 0.2,
  resetOnLeave = false,
}: AnimateComponentProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const durationInSec = duration / 1000
  const delayInSec = delay / 1000

  useGSAP(
    () => {
      const el = containerRef.current
      if (!el) return

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(el, { autoAlpha: 1 })
      })

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const [fromVars, toVars] = getEntryGSAPVars(entry)

        if (onScroll) {
          gsap.set(el, { autoAlpha: 0, ...fromVars })

          ScrollTrigger.create({
            trigger: el,
            start: `top ${(1 - threshold) * 100}%`,
            once: !resetOnLeave,
            onEnter: () => {
              gsap.to(el, {
                ...toVars,
                autoAlpha: 1,
                ease,
                duration: durationInSec,
                delay: delayInSec,
              })
            },
            onLeaveBack: resetOnLeave
              ? () => {
                  if (!el.isConnected) return
                  const exitVars = getExitGSAPVars(exit)
                  gsap.to(el, {
                    ...exitVars,
                    autoAlpha: 0,
                    ease: 'power2.in',
                    duration: durationInSec * 0.6,
                  })
                }
              : undefined,
          })
        } else {
          gsap.fromTo(
            el,
            { ...fromVars, autoAlpha: 0 },
            {
              ...toVars,
              autoAlpha: 1,
              ease,
              duration: durationInSec,
              delay: delayInSec,
            },
          )
        }
      })
    },
    { scope: containerRef },
  )

  return (
    <div ref={containerRef} className={cnm(className)}>
      {children}
    </div>
  )
}

function getEntryGSAPVars(
  animation: EntryAnimation,
): [gsap.TweenVars, gsap.TweenVars] {
  const animations: Record<EntryAnimation, [gsap.TweenVars, gsap.TweenVars]> = {
    fadeIn: [{ opacity: 0 }, { opacity: 1 }],
    fadeInUp: [
      { y: 40, opacity: 0 },
      { y: 0, opacity: 1 },
    ],
    fadeInDown: [
      { y: -40, opacity: 0 },
      { y: 0, opacity: 1 },
    ],
    fadeInLeft: [
      { x: -40, opacity: 0 },
      { x: 0, opacity: 1 },
    ],
    fadeInRight: [
      { x: 40, opacity: 0 },
      { x: 0, opacity: 1 },
    ],
    scaleIn: [
      { scale: 0.9, opacity: 0 },
      { scale: 1, opacity: 1 },
    ],
    slideUp: [
      { y: 60, opacity: 0 },
      { y: 0, opacity: 1 },
    ],
  }

  return animations[animation] ?? animations.fadeInUp
}

function getExitGSAPVars(animation: ExitAnimation): gsap.TweenVars {
  const animations: Record<ExitAnimation, gsap.TweenVars> = {
    fadeOut: { opacity: 0 },
    fadeOutUp: { y: -40, opacity: 0 },
    fadeOutDown: { y: 40, opacity: 0 },
    fadeOutLeft: { x: -40, opacity: 0 },
    fadeOutRight: { x: 40, opacity: 0 },
    scaleOut: { scale: 0.9, opacity: 0 },
    slideDown: { y: 60, opacity: 0 },
  }

  return animations[animation] ?? animations.fadeOutDown
}
