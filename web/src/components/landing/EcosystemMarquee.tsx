import { useEffect, useRef } from 'react'

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

export default function EcosystemMarquee() {
  const items = [...PARTNERS, ...PARTNERS]
  const sectionRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const section = sectionRef.current
    const track = trackRef.current
    if (!section || !track || typeof IntersectionObserver === 'undefined')
      return

    // Start paused; observer arms the animation once in view.
    track.dataset.active = 'false'

    const observer = new IntersectionObserver(
      ([entry]) => {
        track.dataset.active = entry.isIntersecting ? 'true' : 'false'
      },
      { threshold: 0, rootMargin: '0px' },
    )

    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  return (
    <section
      ref={sectionRef}
      aria-label="Ecosystem integrations"
      className="relative py-10 border-y border-lh-line overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-24 z-10"
        style={{
          background:
            'linear-gradient(to right, var(--color-lh-bg) 0%, transparent 100%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-24 z-10"
        style={{
          background:
            'linear-gradient(to left, var(--color-lh-bg) 0%, transparent 100%)',
        }}
      />

      <div className="group overflow-hidden">
        <div
          ref={trackRef}
          className="lh-marquee-track flex items-center gap-12 w-max group-hover:[animation-play-state:paused]"
          data-active="true"
        >
          {items.map((partner, i) => {
            const isDuplicate = i >= PARTNERS.length
            return (
              <img
                key={`${partner.label}-${i}`}
                src={`/assets/marquee/${partner.slug}.svg`}
                alt={isDuplicate ? '' : partner.label}
                aria-hidden={isDuplicate ? 'true' : undefined}
                draggable={false}
                className="h-7 w-auto shrink-0 opacity-70 hover:opacity-100 transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-sui)]"
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}
