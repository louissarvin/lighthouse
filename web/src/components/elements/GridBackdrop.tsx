import { cnm } from '@/utils/style'

// GridBackdrop — 48px editorial grid texture overlay.
//
// Thin wrapper around .lh-grid-bg (styles.css). When opacity or step deviate
// from defaults, apply via inline style rather than generating one-off classes.

export interface GridBackdropProps {
  opacity?: number
  step?: number
  position?: 'absolute' | 'fixed'
  zIndex?: number
  ariaHidden?: boolean
  className?: string
}

export function GridBackdrop({
  opacity = 0.04,
  step = 48,
  position = 'absolute',
  zIndex = 0,
  ariaHidden = true,
  className,
}: GridBackdropProps) {
  const isDefault = opacity === 0.04 && step === 48

  const style: React.CSSProperties = {
    position,
    inset: 0,
    zIndex,
    pointerEvents: 'none',
    ...(!isDefault && {
      backgroundImage: [
        `linear-gradient(to right, rgb(255 255 255 / ${opacity}) 1px, transparent 1px)`,
        `linear-gradient(to bottom, rgb(255 255 255 / ${opacity}) 1px, transparent 1px)`,
      ].join(', '),
      backgroundSize: `${step}px ${step}px`,
    }),
  }

  return (
    <div
      aria-hidden={ariaHidden ? 'true' : undefined}
      className={cnm(isDefault && 'lh-grid-bg', className)}
      style={style}
    />
  )
}
