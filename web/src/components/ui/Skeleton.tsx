import { cnm } from '@/utils/style'

interface SkeletonProps {
  className?: string
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cnm(
        'bg-lh-bg-elev rounded',
        'motion-safe:animate-pulse',
        className,
      )}
      aria-hidden="true"
    />
  )
}
