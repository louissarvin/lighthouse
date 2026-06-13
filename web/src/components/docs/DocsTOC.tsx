import { useEffect, useState } from 'react'
import type { TOCEntry } from '@/lib/docs'
import { cnm } from '@/utils/style'

interface DocsTOCProps {
  entries: Array<TOCEntry>
}

export function DocsTOC({ entries }: DocsTOCProps) {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (intersections) => {
        const visible = intersections.filter((e) => e.isIntersecting)
        if (visible.length > 0) {
          setActiveId(visible[0].target.id)
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    )

    entries.forEach(({ id }) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [entries])

  return (
    <aside
      aria-label="Table of contents"
      className="hidden lg:block w-[200px] shrink-0"
    >
      <div className="sticky top-[72px] pt-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-lh-text-mute mb-4">
          On this page
        </p>
        <nav>
          {entries.map(({ id, text, level }) => (
            <a
              key={id}
              href={`#${id}`}
              className={cnm(
                'block py-1 text-sm transition-colors duration-150',
                level === 3 && 'pl-3',
                activeId === id
                  ? 'text-lh-accent-warm'
                  : 'text-lh-text-mute hover:text-lh-text-dim',
              )}
            >
              {text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  )
}
