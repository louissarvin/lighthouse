import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { ArrowRight } from '@/constants/icons'
import { GlowBorderButton } from '@/components/ui/GlowBorderButton'
import { SplitReveal } from '@/components/elements/SplitReveal'
import { useAuth } from '@/hooks/useAuth'

gsap.registerPlugin(useGSAP)

const BODY_COPY =
  'Lighthouse stores every decision, every outcome, every lesson on Walrus, so your trading edge persists across every session, every device, every chain.'

// Hero headline split into two lines for the per-line wipe reveal.
// Line 2 carries the lh-beam-word italic accent.
const HEADLINE_LINES = [
  <span key="l1">An AI trading coach</span>,
  <span key="l2">
    that{' '}
    <span className="lh-beam-word" aria-hidden="false">
      remembers
    </span>
    .
  </span>,
]

export default function Hero() {
  const containerRef = useRef<HTMLElement>(null)
  const eyebrowRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLParagraphElement>(null)
  const ctaRef = useRef<HTMLDivElement>(null)
  const { isAuthed } = useAuth()

  // Eyebrow, body, and CTA entrance — simple fade-up sequence.
  // The headline lines are handled by SplitReveal internally.
  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const tl = gsap.timeline({ delay: 0.05 })

        tl.fromTo(
          eyebrowRef.current,
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, duration: 0.45, ease: 'sui' },
        )
          .fromTo(
            bodyRef.current,
            { autoAlpha: 0, y: 12 },
            { autoAlpha: 1, y: 0, duration: 0.45, ease: 'sui' },
            // Starts after SplitReveal's second line wipe (approx 0.15 + 0.08 stagger + 0.525 dur)
            '+=0.35',
          )
          .fromTo(
            ctaRef.current,
            { autoAlpha: 0, y: 8 },
            { autoAlpha: 1, y: 0, duration: 0.45, ease: 'sui' },
            '-=0.3',
          )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set([eyebrowRef.current, bodyRef.current, ctaRef.current], {
          autoAlpha: 1,
          y: 0,
        })
      })
    },
    { scope: containerRef },
  )

  return (
    <section
      ref={containerRef}
      aria-label="Hero"
      className="relative min-h-screen flex items-center pt-24 pb-16 px-6"
    >
      {/* Themed hero backdrop. main-dark.svg for light, main-white.svg for dark.
          NOTE: these "SVGs" are raster images wrapped in SVG containers.
          image-rendering hints improve browser upscaling slightly, but the real
          fix is exporting higher-resolution source assets (2x or 3x). */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-0 pointer-events-none overflow-hidden"
      >
        <img
          src="/assets/main-dark.webp"
          alt=""
          draggable={false}
          decoding="async"
          fetchPriority="high"
          className="absolute inset-0 w-full h-full object-cover object-center block dark:hidden"
        />
        <img
          src="/assets/main-white.webp"
          alt=""
          draggable={false}
          decoding="async"
          fetchPriority="high"
          className="absolute inset-0 w-full h-full object-cover object-center hidden dark:block"
        />
        {/* Contrast overlay so the white headline reads cleanly against any
            color in the backdrop. Slightly stronger gradient toward the left
            where the text sits. */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/45 to-black/25" />
      </div>

      <div className="relative z-10 max-w-[1152px] mx-auto w-full">
        <header>
          <div ref={eyebrowRef} style={{ opacity: 0 }}>
            <EyebrowTag prefix="none" className="mb-8">
              <span className="inline-flex items-center gap-3">
                <span>Built for</span>
                <img
                  src="/assets/marquee/sui.svg"
                  alt="Sui"
                  className="h-12 w-auto opacity-70"
                />
                <span aria-hidden="true">/</span>
                <img
                  src="/assets/marquee/walrus.svg"
                  alt="Walrus"
                  className="h-12 w-auto opacity-70"
                />
              </span>
            </EyebrowTag>
          </div>

          {/* Per-line wipe reveal — each line wipes up from overflow-hidden clip.
              SplitReveal wraps h1 so the headline tag is rendered correctly. */}
          <SplitReveal
            as="h1"
            lines={HEADLINE_LINES}
            stagger={0.08}
            delay={0.15}
            immediate
            className={cnm(
              'font-bold tracking-[-0.03em] leading-[0.95] mb-6',
              'text-[#faf8f5]',
              'text-[44px] sm:text-[64px] lg:text-[88px] xl:text-[100px]',
            )}
          />

          <p
            ref={bodyRef}
            className="text-white/75 text-[18px] leading-relaxed max-w-[560px] mb-10"
            style={{ opacity: 0 }}
          >
            {BODY_COPY}
          </p>
        </header>

        <div
          ref={ctaRef}
          className="flex flex-wrap items-center gap-6"
          style={{ opacity: 0 }}
        >
          {isAuthed ? (
            <GlowBorderButton
              href="/trade"
              size="lg"
              ariaLabel="Open Lighthouse trade"
              className="text-[#faf8f5]"
            >
              Open trade
              <ArrowRight size={16} aria-hidden="true" />
            </GlowBorderButton>
          ) : (
            <>
              <GlowBorderButton
                href="https://t.me/LighthouseCoachBot"
                target="_blank"
                size="lg"
                ariaLabel="Launch Lighthouse on Telegram"
                className="text-[#faf8f5]"
              >
                Launch on Telegram
                <ArrowRight size={16} aria-hidden="true" />
              </GlowBorderButton>
              <Link
                to="/auth"
                className="text-sm font-medium text-lh-accent hover:text-lh-accent-warm transition-colors"
              >
                Or sign in on web →
              </Link>
            </>
          )}

          <span className="text-sm font-medium text-lh-text-mute">
            Whitepaper (Q3)
          </span>
        </div>
      </div>
    </section>
  )
}
