import { useState } from 'react'
import { DocsSidebar } from './DocsSidebar'
import { DocsTOC } from './DocsTOC'
import type { TOCEntry } from '@/lib/docs'
import { MobileNavDrawer } from '@/components/ui/MobileNavDrawer'
import { Menu } from '@/constants/icons'
import PillNav from '@/components/landing/PillNav'
import FooterCard from '@/components/landing/FooterCard'

interface DocsLayoutProps {
  // Kept in the prop API so existing call sites continue to compile.
  // No longer rendered now that the breadcrumb is removed.
  section?: string
  page?: string
  toc?: Array<TOCEntry>
  children: React.ReactNode
}

export function DocsLayout({ toc, children }: DocsLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-lh-bg">
      <PillNav />

      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex gap-12 xl:gap-16 pt-28 pb-24">
          {/* Left sidebar - desktop only */}
          <aside className="hidden lg:block w-[240px] shrink-0">
            <DocsSidebar />
          </aside>

          {/* Mobile sidebar drawer */}
          <MobileNavDrawer
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          >
            <DocsSidebar />
          </MobileNavDrawer>

          {/* Prose content */}
          <main className="min-w-0 flex-1 max-w-[720px]" id="docs-content">
            {/* Mobile-only sidebar toggle, sits above prose so users still
                have a way to open the docs nav drawer now that the
                breadcrumb (which held the trigger) is gone. */}
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden inline-flex items-center gap-2 mb-6 font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-dim hover:text-lh-text transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring rounded-sm"
            >
              <Menu size={16} strokeWidth={1.5} />
              Docs nav
            </button>

            {children}
          </main>

          {/* Right TOC rail */}
          {toc && toc.length > 0 && <DocsTOC entries={toc} />}
        </div>
      </div>

      <FooterCard />
    </div>
  )
}
