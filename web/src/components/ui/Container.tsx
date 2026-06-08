import { cnm } from '@/utils/style'

interface ContainerProps {
  children: React.ReactNode
  className?: string
  size?: 'default' | 'narrow' | 'wide'
}

export function Container({
  children,
  className,
  size = 'default',
}: ContainerProps) {
  return (
    <div
      className={cnm(
        'mx-auto w-full px-4 sm:px-6 lg:px-8',
        size === 'default' && 'max-w-[1152px]',
        size === 'narrow' && 'max-w-[640px]',
        size === 'wide' && 'max-w-[1280px]',
        className,
      )}
    >
      {children}
    </div>
  )
}
