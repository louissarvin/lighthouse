import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { ClassValue } from 'clsx'

export const cnm = (...values: Array<ClassValue>) => twMerge(clsx(values))

/**
 * Conditionally apply a class when `condition` is true.
 * Shorthand for `cnm(condition && 'class-name')`.
 */
export const cnmIf = (condition: boolean, className: string, fallback = '') =>
  condition ? className : fallback

/**
 * Map a status string to a color class. Keeps color logic out of JSX.
 * Extend as new statuses are added.
 */
export const statusColor = (
  status: 'open' | 'settled' | 'lost' | 'redeemed' | string,
): string => {
  switch (status) {
    case 'open':
      return 'text-blue-400'
    case 'settled':
      return 'text-green-400'
    case 'lost':
      return 'text-red-400'
    case 'redeemed':
      return 'text-neutral-400'
    default:
      return 'text-neutral-300'
  }
}
