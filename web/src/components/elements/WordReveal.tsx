import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger, useGSAP)

interface WordRevealProps {
  children: string
  className?: string
}

export function WordReveal({ children, className }: WordRevealProps) {
  const containerRef = useRef<HTMLParagraphElement>(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const words =
          containerRef.current!.querySelectorAll<HTMLElement>('.lh-word')
        gsap.fromTo(
          words,
          { autoAlpha: 0.15, y: 8 },
          {
            autoAlpha: 1,
            y: 0,
            stagger: 0.04,
            ease: 'none',
            scrollTrigger: {
              trigger: containerRef.current,
              scrub: 1.5,
              start: 'top 80%',
              end: 'bottom 40%',
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        const words =
          containerRef.current!.querySelectorAll<HTMLElement>('.lh-word')
        words.forEach((w) => {
          w.style.opacity = '1'
          w.style.transform = 'none'
          w.style.visibility = 'visible'
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
          className="lh-word inline-block"
          style={{ opacity: 0.15, transform: 'translateY(8px)' }}
          aria-hidden="true"
        >
          {word}
          {i < wordList.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}
