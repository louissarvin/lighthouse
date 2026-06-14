import Lenis from 'lenis'
import { useEffect } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { CustomEase } from 'gsap/CustomEase'

gsap.registerPlugin(ScrollTrigger, CustomEase)

// Register the Sui house easing once — referenced as 'sui' throughout the codebase.
// GSAP does not parse CSS cubic-bezier() strings natively; CustomEase is required.
CustomEase.create('sui', '0.51, 0, 0.08, 1')

// Global motion baseline: every tween inherits these unless overridden explicitly.
gsap.defaults({ ease: 'sui', duration: 0.525 })

export default function LenisSmoothScrollProvider() {
  useEffect(() => {
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    if (prefersReduced) return

    const lenis = new Lenis({
      lerp: 0.1,
      duration: 1.2,
      smoothWheel: true,
      wheelMultiplier: 0.9,
      touchMultiplier: 1.4,
    })

    lenis.on('scroll', ScrollTrigger.update)

    const tickerCallback = (time: number) => {
      lenis.raf(time * 1000)
    }

    gsap.ticker.add(tickerCallback)
    gsap.ticker.lagSmoothing(0)

    // Defer refresh by one frame so Lenis has established its scroll-position
    // proxy before ScrollTrigger reads DOM geometry (fixes pin misalignment on
    // hard navigation). See gsap-lenis-motion.md §2 and WEB_AUDIT.md HIGH-3.
    requestAnimationFrame(() => ScrollTrigger.refresh())

    let resizeTimer: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => ScrollTrigger.refresh(), 200)
    }
    window.addEventListener('resize', onResize, { passive: true })

    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(resizeTimer)
      gsap.ticker.remove(tickerCallback)
      lenis.destroy()
    }
  }, [])

  return null
}
