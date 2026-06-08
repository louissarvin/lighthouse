import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

import { cnm } from '@/utils/style'
import { WordmarkLogo } from '@/components/ui/WordmarkLogo'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { useAuth } from '@/hooks/useAuth'

gsap.registerPlugin(useGSAP)

/**
 * AppNav — pill nav variant for the authenticated app routes (/trade,
 * /predict, /portfolio). Mirrors PillNav's amber/dark visual language with a
 * trade-focused link set and an account dropdown.
 */
const APP_LINKS = [
  { label: 'Coach', to: '/coach' as const },
  { label: 'Trade', to: '/trade' as const },
  { label: 'Predict', to: '/predict' as const },
  { label: 'Portfolio', to: '/portfolio' as const },
  { label: 'Setup', to: '/onboarding' as const },
] as const

function shortAddr(addr: string | null | undefined): string {
  if (!addr) return ''
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export default function AppNav() {
  const navRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const { profile, isAuthed, signOut } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    const handleScroll = () => {
      if (!pillRef.current) return
      pillRef.current.dataset.scrolled = window.scrollY > 24 ? 'true' : 'false'
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          navRef.current,
          { y: -16, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.6,
            ease: 'power3.out',
            delay: 0.05,
          },
        )
      })
      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(navRef.current, { autoAlpha: 1, y: 0 })
      })
    },
    { scope: navRef },
  )

  async function handleSignOut() {
    setMenuOpen(false)
    await signOut()
    await navigate({ to: '/' })
  }

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
          aria-label="App navigation"
          className="hidden md:flex items-center gap-5"
        >
          {APP_LINKS.map(({ label, to }) => (
            <Link
              key={to}
              to={to}
              activeProps={{ className: 'text-lh-accent' }}
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

          {isAuthed && profile ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className={cnm(
                  'inline-flex items-center gap-2 rounded-full',
                  'bg-lh-bg-elev border border-lh-line',
                  'text-sm px-3 py-1.5 leading-none',
                  'text-lh-text-dim hover:text-lh-text',
                  'font-mono tabular-nums',
                  'focus-visible:outline-2 focus-visible:outline-lh-focus-ring focus-visible:outline-offset-2',
                )}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-lh-accent"
                  aria-hidden="true"
                />
                {shortAddr(profile.suiAddress)}
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className={cnm(
                    'absolute right-0 top-full mt-2 min-w-[200px]',
                    'rounded-xl border border-lh-line bg-lh-bg-elev shadow-xl',
                    'py-2',
                  )}
                >
                  <Link
                    to="/onboarding"
                    className="block px-4 py-2 text-sm text-lh-text-dim hover:text-lh-text hover:bg-lh-bg/60 transition-colors"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                  >
                    Onboarding status
                  </Link>
                  <a
                    href={`https://suiscan.xyz/testnet/account/${profile.suiAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2 text-sm text-lh-text-dim hover:text-lh-text hover:bg-lh-bg/60 transition-colors"
                    role="menuitem"
                  >
                    Open in Explorer
                  </a>
                  <a
                    href="https://t.me/LighthouseCoachBot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2 text-sm text-lh-text-dim hover:text-lh-text hover:bg-lh-bg/60 transition-colors"
                    role="menuitem"
                  >
                    Open Telegram bot
                  </a>
                  <div className="my-1 border-t border-lh-line" />
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="block w-full text-left px-4 py-2 text-sm text-lh-text-dim hover:text-lh-accent hover:bg-lh-bg/60 transition-colors"
                    role="menuitem"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
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
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
