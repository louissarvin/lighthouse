import { cnm } from '@/utils/style'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'mono'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-4 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cnm(
        'inline-flex items-center gap-2 font-semibold transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-focus-ring',

        variant === 'primary' && [
          'lh-cta',
          'rounded-full',
          'bg-lh-accent text-lh-bg',
          'hover:bg-lh-accent-warm',
          'active:scale-[0.98]',
        ],

        variant === 'secondary' && [
          'bg-transparent text-lh-text-dim rounded-none px-0',
          'hover:text-lh-text',
          'relative after:absolute after:bottom-0 after:left-0',
          'after:h-px after:w-0 after:bg-lh-accent-warm',
          'after:transition-[width] after:duration-200',
          'hover:after:w-full',
        ],

        variant === 'ghost' && [
          'rounded-full',
          'bg-transparent text-lh-text-dim',
          'border border-lh-line',
          'hover:border-lh-line-mid hover:text-lh-text',
        ],

        variant === 'mono' && [
          'rounded-lg',
          'bg-lh-bg-elev text-lh-text font-mono text-xs tracking-[0.12em] uppercase',
          'border border-lh-line',
          'hover:border-lh-line-mid',
        ],

        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
