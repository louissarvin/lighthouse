import { cnm } from '@/utils/style'

interface WordmarkLogoProps {
  size?: 'sm' | 'md'
  className?: string
}

export function WordmarkLogo({ size = 'md', className }: WordmarkLogoProps) {
  const heightClass = size === 'sm' ? 'h-10' : 'h-16'

  return (
    <span
      className={cnm('inline-flex items-center select-none', className)}
      role="img"
      aria-label="Lighthouse"
    >
      <img
        src="/assets/logo-black.svg"
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cnm(heightClass, 'w-auto block dark:hidden')}
      />
      <img
        src="/assets/logo-white.svg"
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cnm(heightClass, 'w-auto hidden dark:block')}
      />
    </span>
  )
}
