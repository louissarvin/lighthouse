import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger, useGSAP)

interface MaskRevealProps {
  children: React.ReactNode
  className?: string
  delay?: number
}

export function MaskReveal({
  children,
  className,
  delay = 0,
}: MaskRevealProps) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const el = wrapRef.current
        gsap.fromTo(
          el,
          { clipPath: 'inset(100% 0 0 0)' },
          {
            clipPath: 'inset(0% 0 0 0)',
            delay,
            onComplete: () => {
              if (el) el.style.willChange = 'auto'
            },
            scrollTrigger: {
              trigger: el,
              start: 'top 85%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        if (wrapRef.current) {
          wrapRef.current.style.clipPath = 'none'
        }
      })
    },
    { scope: wrapRef },
  )

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ clipPath: 'inset(100% 0 0 0)', willChange: 'clip-path' }}
    >
      {children}
    </div>
  )
}
