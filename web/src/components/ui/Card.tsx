import { cnm } from '@/utils/style'

type CardAs = 'div' | 'article' | 'section' | 'a'

interface CardProps {
  /**
   * Polymorphic element. Use `'article'` for self-contained grid items,
   * `'a'` for clickable navigation cards, otherwise `'div'`.
   */
  as?: CardAs
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
  href?: string
  target?: string
  rel?: string
}

/**
 * The canonical Lighthouse card.
 *
 * One surface, one set of rules. Used everywhere a card lives in a grid:
 * landing primitives, protocol trust signals, docs feature lists, etc.
 *
 * Design rules locked:
 *  - No border (shadow alone defines the surface)
 *  - rounded-3xl (24px)
 *  - p-8 default padding (override via className for tighter layouts)
 *  - bg-lh-bg-elev (warm tusk in light, near-black-elev in dark)
 *  - Layered shadow (small flat + large soft) — adapts to dark mode
 */
export function Card({
  as = 'div',
  className,
  style,
  children,
  href,
  target,
  rel,
}: CardProps) {
  const Component = as as 'div'
  const props = as === 'a' ? { href, target, rel } : {}
  return (
    <Component
      {...props}
      style={style}
      className={cnm(
        'bg-lh-bg-elev rounded-3xl p-8',
        'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_32px_rgb(0_0_0/0.06)]',
        'dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_8px_32px_rgb(0_0_0/0.3)]',
        className,
      )}
    >
      {children}
    </Component>
  )
}
