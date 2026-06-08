import { cnm } from '@/utils/style'

interface EyebrowTagProps {
  children: React.ReactNode
  /** @deprecated use prefix="dot" instead */
  dot?: boolean
  /** Decorative prefix style. Defaults to 'dash'. Pass 'none' to suppress. */
  prefix?: 'dash' | 'dot' | 'none'
  className?: string
}

export function EyebrowTag({
  children,
  dot = false,
  prefix,
  className,
}: EyebrowTagProps) {
  // Resolve effective prefix: explicit prop wins, then legacy dot bool, then default dash
  const resolvedPrefix: 'dash' | 'dot' | 'none' =
    prefix !== undefined ? prefix : dot ? 'dot' : 'dash'

  return (
    <p
      className={cnm(
        'font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-lh-text-mute leading-none',
        className,
      )}
      role="presentation"
    >
      {resolvedPrefix === 'dash' && (
        <span
          className="inline-block align-middle w-6 h-px bg-lh-text-mute mr-3"
          aria-hidden="true"
        />
      )}
      {resolvedPrefix === 'dot' && (
        <span className="text-lh-accent mr-2" aria-hidden="true">
          ·
        </span>
      )}
      {children}
    </p>
  )
}
