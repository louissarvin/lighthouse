import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { cnm } from '@/utils/style'
import { WordmarkLogo } from '@/components/ui/WordmarkLogo'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { ArrowRight } from '@/constants/icons'
import { useAuth } from '@/hooks/useAuth'

gsap.registerPlugin(useGSAP)

const NAV_LINKS = [
  { label: 'Protocol', to: '/protocol' as const, exact: true },
  { label: 'Docs', to: '/docs' as const, exact: false },
] as const

export default function PillNav() {
  const pillRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const { isAuthed } = useAuth()

  useEffect(() => {
    const handleScroll = () => {
      if (!pillRef.current) return
      pillRef.current.dataset.scrolled = window.scrollY > 24 ? 'true' : 'false'
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          navRef.current,
          { y: -16, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, duration: 0.6, ease: 'power3.out', delay: 0.1 },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(navRef.current, { autoAlpha: 1, y: 0 })
      })
    },
    { scope: navRef },
  )

  return (
    <header
      ref={navRef}
      role="banner"
      className="fixed inset-x-0 top-4 z-40 flex justify-center px-4 pointer-events-none"
      style={{ opacity: 0 }}
    >
      <div
        ref={pillRef}
        data-scrolled="false"
        style={{ borderRadius: 'var(--radius-pill)' }}
        className={cnm(
          'pointer-events-auto',
          'flex items-center gap-6 border border-lh-line',
          'bg-lh-bg-elev/70 backdrop-blur-xl',
          'transition-all duration-200 ease-out',
          'px-5 py-2.5',
          'data-[scrolled=true]:py-1.5 data-[scrolled=true]:px-4',
        )}
      >
        <Link
          to="/"
          aria-label="Lighthouse home"
          className="flex items-center shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring rounded-sm"
        >
          <WordmarkLogo size="sm" />
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-5"
        >
          {NAV_LINKS.map(({ label, to, exact }) => (
            <Link
              key={to}
              to={to}
              activeProps={{ className: 'text-lh-accent' }}
              activeOptions={{ exact }}
              className={cnm(
                'text-[11px] font-mono uppercase tracking-[0.18em]',
                'text-lh-text-dim hover:text-lh-text',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-sui)]',
                'relative after:absolute after:bottom-0 after:left-0',
                'after:h-px after:bg-lh-line-mid after:w-0 hover:after:w-full',
                'after:transition-[width] after:duration-[var(--dur-base)] after:ease-[var(--ease-sui)]',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3 ml-auto md:ml-0">
          <ThemeToggle />
          {isAuthed ? (
            <Link
              to="/trade"
              style={{
                boxShadow:
                  'rgb(255 255 255 / 0.2) 0px 1px 1px 0px inset, rgb(255 255 255 / 0.12) 0px 1px 0px 0px inset',
              }}
              className={cnm(
                'lh-cta',
                'inline-flex items-center gap-2 rounded-full',
                'bg-lh-accent text-lh-bg font-semibold',
                'text-sm px-5 py-2.5 leading-none',
                'hover:bg-lh-accent-warm transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-lh-focus-ring focus-visible:outline-offset-2',
              )}
            >
              Open trade
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          ) : (
            <Link
              to="/auth"
              style={{
                boxShadow:
                  'rgb(255 255 255 / 0.2) 0px 1px 1px 0px inset, rgb(255 255 255 / 0.12) 0px 1px 0px 0px inset',
              }}
              className={cnm(
                'lh-cta',
                'inline-flex items-center gap-2 rounded-full',
                'bg-lh-accent text-lh-bg font-semibold',
                'text-sm px-5 py-2.5 leading-none',
                'hover:bg-lh-accent-warm transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:outline-lh-focus-ring focus-visible:outline-offset-2',
              )}
            >
              Sign in
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
