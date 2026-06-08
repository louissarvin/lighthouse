import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

// GlowBorderButton — rotating amber conic-gradient arc CTA.
//
// Technique: walrus.xyz glow border (walrus.md §Rotating Glow Border CTA).
// The arc is driven by CSS animation on @property --lh-glow-angle declared
// in styles.css. A separate property name avoids conflicts with --lh-angle.
//
// Safari compat: -webkit-mask-composite uses 'destination-out' (not 'xor')
// to match spec 'exclude'. Mirrors the existing .lh-cta pattern in styles.css.
//
// Reduced motion: .lh-glow-arc class is paused via @media rule in styles.css.

export interface GlowBorderButtonProps {
  as?: 'a' | 'button'
  href?: string
  onClick?: () => void
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  arcColor?: string
  arcSpeed?: number // seconds per revolution, default 6
  arcSpan?: number // degrees of visible arc, default 70
  ariaLabel?: string
  className?: string
  target?: '_blank' | '_self'
}

const sizeMap = {
  sm: 'h-10 px-4 text-sm',
  md: 'h-12 px-6 text-base',
  lg: 'h-14 px-8 text-base',
} as const

export function GlowBorderButton({
  as: Tag = 'a',
  href,
  onClick,
  children,
  size = 'md',
  arcColor = 'var(--color-amber)',
  arcSpeed = 6,
  arcSpan = 70,
  ariaLabel,
  className,
  target,
}: GlowBorderButtonProps) {
  // Arc span: walrus uses 48%->52% of circle = 4% = ~14deg. We expose arcSpan
  // in degrees and convert to percentage of 360.
  const halfSpan = arcSpan / 2
  const center = 50 // percentage at center of arc (top of circle)
  const startPct = center - halfSpan / 3.6 // convert deg to pct
  const endPct = center + halfSpan / 3.6

  // Build the conic-gradient stop string with the configured arc color.
  // The gradient rotates via CSS animation (lh-glow-border-spin keyframe).
  const arcGradient = [
    `rgba(0,0,0,0) 0%`,
    `rgba(0,0,0,0) ${Math.max(0, startPct - 10).toFixed(1)}%`,
    `${arcColor} ${startPct.toFixed(1)}%`,
    `${arcColor} ${endPct.toFixed(1)}%`,
    `rgba(0,0,0,0) ${Math.min(100, endPct + 10).toFixed(1)}%`,
    `rgba(0,0,0,0) 100%`,
  ].join(', ')

  const extraProps =
    Tag === 'a'
      ? {
          href,
          target,
          ...(target === '_blank' ? { rel: 'noopener noreferrer' } : {}),
        }
      : { type: 'button' as const, onClick }

  return (
    <Tag
      aria-label={ariaLabel}
      className={cnm(
        'relative inline-flex items-center justify-center font-semibold',
        'text-lh-text bg-transparent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',
        'transition-opacity duration-[var(--dur-fast)]',
        'hover:opacity-90 active:scale-[0.98] active:transition-transform',
        sizeMap[size],
        className,
      )}
      style={{ borderRadius: 'var(--radius-pill)' }}
      {...extraProps}
    >
      {/* Border mask layer — donut mask shows only the 1px border area */}
      <span
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          borderRadius: 'inherit',
          padding: '1px',
          mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          maskComposite: 'exclude',
          WebkitMask:
            'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'destination-out',
        }}
      >
        {/* Rotating conic-gradient arc — 400x400 centered oversized div so
            the gradient covers all border angles at every rotation step.
            .lh-glow-arc is the hook for the reduced-motion pause rule in
            styles.css (@media prefers-reduced-motion: reduce). */}
        <span
          className="lh-glow-arc absolute left-1/2 top-1/2 h-[400px] w-[400px]"
          aria-hidden="true"
          style={{
            transform: 'translate(-50%, -50%)',
            background: `conic-gradient(from var(--lh-glow-angle, 0deg), ${arcGradient})`,
            animation: `lh-glow-border-spin ${arcSpeed}s linear infinite`,
          }}
        />
      </span>

      {/* Subtle static outer border so the button is visible before the arc
          completes its first revolution and in reduced-motion state. */}
      <span
        className="pointer-events-none absolute inset-0 rounded-[inherit] border border-lh-line"
        aria-hidden="true"
      />

      {/* Content */}
      <span className="relative z-10 inline-flex items-center gap-2">
        {children}
      </span>
    </Tag>
  )
}
