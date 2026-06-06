import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { WordmarkLogo } from '@/components/ui/WordmarkLogo'

gsap.registerPlugin(ScrollTrigger, useGSAP)

interface NavLink {
  label: string
  href?: string
  external?: boolean
  disabled?: boolean
}

interface NavSection {
  heading: string
  links: Array<NavLink>
}

const NAV_SECTIONS: Array<NavSection> = [
  {
    heading: 'Protocol',
    links: [
      { label: 'Docs', href: '/docs', external: false },
      { label: 'Whitepaper (Q3)', disabled: true },
      {
        label: 'GitHub',
        href: 'https://github.com/lighthouse-sui',
        external: true,
      },
      { label: 'Audit reports', href: '/docs/audits', external: false },
    ],
  },
  {
    heading: 'Community',
    links: [
      {
        label: 'Twitter',
        href: 'https://twitter.com/lighthousesui',
        external: true,
      },
      {
        label: 'Discord',
        href: 'https://discord.gg/lighthouse',
        external: true,
      },
      {
        label: 'Telegram bot',
        href: 'https://t.me/LighthouseCoachBot',
        external: true,
      },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy', external: false },
      { label: 'Terms', href: '/terms', external: false },
    ],
  },
]

export default function FooterCard() {
  const footerRef = useRef<HTMLElement>(null)
  const watermarkRef = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // Footer card lift entrance.
        gsap.fromTo(
          footerRef.current,
          { scale: 0.99, y: 8, autoAlpha: 0.9 },
          {
            scale: 1,
            y: 0,
            autoAlpha: 1,
            scrollTrigger: {
              trigger: footerRef.current,
              start: 'top 95%',
              toggleActions: 'play none none none',
            },
            onComplete: () => {
              if (footerRef.current) {
                footerRef.current.style.willChange = 'auto'
              }
            },
          },
        )

        // Watermark wordmark rises slightly and saturates from 0 to final
        // low-opacity rest state. Subtle but adds depth on enter.
        gsap.fromTo(
          watermarkRef.current,
          { y: 28, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 1.1,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: footerRef.current,
              start: 'top 90%',
              toggleActions: 'play none none none',
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(footerRef.current, { scale: 1, y: 0, autoAlpha: 1 })
        gsap.set(watermarkRef.current, { y: 0, autoAlpha: 1 })
      })
    },
    { scope: footerRef },
  )

  return (
    <footer
      ref={footerRef}
      role="contentinfo"
      className="bg-lh-bg-elev -mt-12 relative z-10 overflow-hidden"
      style={{
        borderRadius: 'var(--radius-footer) var(--radius-footer) 0 0',
        willChange: 'transform, opacity',
      }}
    >
      {/* Giant Lighthouse wordmark watermark, centered horizontally and pinned
          to the lower half. Very low opacity so it reads as texture, not text. */}
      <div
        ref={watermarkRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[-3vw] z-0 flex justify-center select-none"
        style={{ opacity: 0 }}
      >
        <span
          className="font-bold tracking-[-0.04em] leading-none text-lh-text whitespace-nowrap"
          style={{
            fontSize: 'clamp(72px, 12vw, 200px)',
            opacity: 0.05,
          }}
        >
          Lighthouse
        </span>
      </div>

      <div className="max-w-6xl mx-auto px-8 pt-14 pb-8 relative z-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1fr] gap-12 mb-16">
          <div className="flex flex-col gap-4">
            <Link
              to="/"
              aria-label="Lighthouse home"
              className="w-fit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring rounded-sm"
            >
              <WordmarkLogo size="md" />
            </Link>
            <p className="text-sm text-lh-text-dim leading-relaxed max-w-[240px]">
              An AI trading coach with verifiable memory. Built on Sui.
            </p>
          </div>

          {NAV_SECTIONS.map((section) => (
            <nav key={section.heading} aria-label={`${section.heading} links`}>
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-5">
                {section.heading}
              </p>
              <ul className="space-y-3" role="list">
                {section.links.map((link) => (
                  <li key={link.label}>
                    {link.disabled ? (
                      <span className="text-sm text-lh-text-mute cursor-default">
                        {link.label}
                      </span>
                    ) : (
                      <a
                        href={link.href}
                        {...(link.external
                          ? { target: '_blank', rel: 'noopener noreferrer' }
                          : {})}
                        className={cnm(
                          'text-sm text-lh-text-dim hover:text-lh-text',
                          'transition-colors duration-150',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring rounded-sm',
                        )}
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
    </footer>
  )
}
