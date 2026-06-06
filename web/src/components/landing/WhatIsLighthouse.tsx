import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import { ColorWordReveal } from '@/components/elements/ColorWordReveal'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const DESCRIPTION =
  'Lighthouse is an AI trading coach with memory you can verify. Three layers stand between you and a forgetful agent: persistent memory on Walrus, encrypted access through SEAL, scoped execution on DeepBook.'

const CARDS = [
  {
    eyebrow: 'Coaching',
    title: 'Just talk to it',
    body: 'Tell Lighthouse what you want in plain English. It plans the trade, sizes the risk, and executes on DeepBook within your budget.',
  },
  {
    eyebrow: 'Memory',
    title: 'Remembers everything',
    body: 'Every session, every trade, every lesson is written to Walrus. Cross-device, cross-session, yours to query forever.',
  },
  {
    eyebrow: 'Control',
    title: 'You hold the keys',
    body: 'SEAL-encrypted profiles. Scoped agent wallets. Revoke any access in one transaction. No custody, ever.',
  },
] as const

// Partner SVG logos live in /public/assets/marquee/. Each entry maps a
// human label (for a11y) to the slug used to build the file path.
const PARTNERS = [
  { label: 'Walrus', slug: 'walrus' },
  { label: 'Sui', slug: 'sui' },
  { label: 'Mysten Labs', slug: 'mysten' },
  { label: 'DeepBook', slug: 'deepbook' },
  { label: 'SEAL', slug: 'seal' },
  { label: 'Atoma', slug: 'atoma' },
  { label: 'Enoki', slug: 'enoki' },
  { label: 'zkLogin', slug: 'zklogin' },
  { label: 'SuiNS', slug: 'suins' },
] as const

export default function WhatIsLighthouse() {
  const sectionRef = useRef<HTMLElement>(null)
  const cardGridRef = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const cards =
          cardGridRef.current?.querySelectorAll<HTMLElement>('.what-is-card')
        if (!cards?.length) return

        gsap.fromTo(
          cards,
          { y: 20, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.55,
            stagger: 0.08,
            ease: 'sui',
            scrollTrigger: {
              trigger: cardGridRef.current,
              start: 'top 78%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        const cards =
          cardGridRef.current?.querySelectorAll<HTMLElement>('.what-is-card')
        cards?.forEach((el) => gsap.set(el, { autoAlpha: 1, y: 0 }))
      })
    },
    { scope: sectionRef },
  )

  return (
    <section
      ref={sectionRef}
      aria-label="What is Lighthouse"
      className="py-24 md:py-32"
    >
      <div className="max-w-6xl mx-auto px-6">
        {/* 2-col header: heading left, description right (velfi pattern) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-12 items-start mb-12 lg:mb-14">
          <div>
            <EyebrowTag className="mb-4">What is Lighthouse</EyebrowTag>
            <MaskReveal>
              <h2 className="text-4xl md:text-[48px] font-bold leading-[1.1] tracking-[-1px] text-lh-text">
                What is Lighthouse?
              </h2>
            </MaskReveal>
          </div>
          <div className="lg:self-center lg:max-w-[480px]">
            <ColorWordReveal pace="fast" className="text-[16px] leading-[1.7]">
              {DESCRIPTION}
            </ColorWordReveal>
          </div>
        </div>

        {/* 4-col grid: first "Coaching" card spans 2 (featured with bg image,
            velfi pattern), other two cards stay 1-wide. Pre-render invisible;
            GSAP sets autoAlpha after hydration. */}
        <div
          ref={cardGridRef}
          className="grid grid-cols-1 sm:grid-cols-4 gap-5"
        >
          {CARDS.map((card, i) => {
            const isFeatured = i === 0
            return (
              <Card
                key={card.title}
                as="article"
                className={cnm(
                  'what-is-card flex flex-col relative overflow-hidden',
                  isFeatured && 'sm:col-span-2 min-h-[280px]',
                )}
                style={{ opacity: 0 }}
              >
                {isFeatured && (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 pointer-events-none overflow-hidden"
                  >
                    <img
                      src="/assets/card-white.webp"
                      alt=""
                      draggable={false}
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover object-right scale-[1.25] origin-right block dark:hidden"
                    />
                    <img
                      src="/assets/card-dark.webp"
                      alt=""
                      draggable={false}
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover object-right scale-[1.25] origin-right hidden dark:block"
                    />
                    {/* Soft fade at the LEFT edge of the image panel so it
                        blends into the card surface instead of a hard seam. */}
                    <div className="absolute inset-0 bg-gradient-to-r from-lh-bg-elev to-transparent" />
                  </div>
                )}

                <div
                  className={cnm(
                    'relative z-10 flex flex-col',
                    isFeatured && 'max-w-[50%]',
                  )}
                >
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-3">
                    {card.eyebrow}
                  </p>
                  <h3 className="text-xl font-semibold leading-[1.2] tracking-[-0.5px] text-lh-text mb-3">
                    {card.title}
                  </h3>
                  <p className="text-sm text-lh-text-dim leading-relaxed">
                    {card.body}
                  </p>
                </div>
              </Card>
            )
          })}
        </div>

        {/* Infinite ecosystem marquee anchored at the bottom of the section.
            Pure CSS keyframe (translateX 0 -> -50%) plus [...PARTNERS, ...PARTNERS]
            duplication = seamless infinite loop. Edge fades via .lh-marquee
            ::before/::after gradients in styles.css. */}
        <div
          className="mt-16 flex items-center gap-8"
          aria-label="Infrastructure partners"
        >
          <span
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute shrink-0 leading-none"
            aria-hidden="true"
          >
            Built on
          </span>
          <div className="lh-marquee group flex-1 relative overflow-hidden">
            <div className="lh-marquee-track flex items-center gap-16 w-max group-hover:[animation-play-state:paused]">
              {[...PARTNERS, ...PARTNERS].map((partner, i) => {
                const isDuplicate = i >= PARTNERS.length
                return (
                  <img
                    key={`whatis-partner-${partner.label}-${i}`}
                    src={`/assets/marquee/${partner.slug}.svg`}
                    alt={isDuplicate ? '' : partner.label}
                    aria-hidden={isDuplicate ? 'true' : undefined}
                    draggable={false}
                    className="h-10 md:h-12 w-auto shrink-0 opacity-80 hover:opacity-100 transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-sui)]"
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
