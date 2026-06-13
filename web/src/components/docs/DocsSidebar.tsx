import { Link, useMatchRoute } from '@tanstack/react-router'
import { cnm } from '@/utils/style'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { DOCS_NAV_TREE } from '@/lib/docs'

export function DocsSidebar() {
  const matchRoute = useMatchRoute()

  return (
    <nav
      aria-label="Documentation navigation"
      className="sticky top-[72px] h-[calc(100vh-72px)] overflow-y-auto py-6 pr-4"
    >
      {DOCS_NAV_TREE.map((group) => (
        <div key={group.section} className="mb-6">
          <EyebrowTag prefix="none" className="mb-2 px-3">
            {group.section}
          </EyebrowTag>
          <ul role="list" className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = Boolean(
                matchRoute({ to: '/docs/$slug', params: { slug: item.slug } }),
              )
              return (
                <li key={item.slug}>
                  <Link
                    to="/docs/$slug"
                    params={{ slug: item.slug }}
                    className={cnm(
                      'block px-3 py-1.5 rounded text-sm transition-colors duration-150',
                      isActive
                        ? 'text-lh-accent bg-lh-bg-elev font-medium'
                        : 'text-lh-text-dim hover:text-lh-text',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
