import { Link } from '@tanstack/react-router'
import { Menu } from '@/constants/icons'

interface BreadcrumbBarProps {
  page: string
  onOpenSidebar?: () => void
  // Optional, kept in the prop API so existing call sites that still pass
  // `section` continue to compile. Not rendered.
  section?: string
}

// Security: all href values are internal routes. No user-controlled data flows
// into the `to` prop. Open redirect risk (CWE-601) is not present here.
//
// Layout: simplified from 4 levels (Home / Docs / Section / Page) to 2
// (Docs / Page). The Lighthouse pill nav already provides a home anchor via
// the logo, and the section level was redundant with the page H1 below.
export function BreadcrumbBar({ page, onOpenSidebar }: BreadcrumbBarProps) {
  return (
    <div className="sticky top-[52px] z-30 h-12 flex items-center border-b border-lh-line bg-lh-bg/95 backdrop-blur-sm px-4 sm:px-6 lg:px-8">
      {/* Mobile: sidebar toggle */}
      <button
        onClick={onOpenSidebar}
        aria-label="Open navigation"
        className="lg:hidden mr-4 text-lh-text-dim hover:text-lh-text transition-colors duration-150"
      >
        <Menu size={18} strokeWidth={1.5} />
      </button>

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute">
          <li>
            <Link
              to="/docs"
              className="hover:text-lh-text-dim transition-colors duration-150"
            >
              Docs
            </Link>
          </li>
          <li aria-hidden="true" className="select-none">
            /
          </li>
          <li className="text-lh-text">{page}</li>
        </ol>
      </nav>
    </div>
  )
}
