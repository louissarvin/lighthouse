import { Link } from '@tanstack/react-router'

import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { useAuth } from '@/hooks/useAuth'
import { cnm } from '@/utils/style'

/**
 * Portfolio entry point for the risk profile.
 *
 * Shows completion status and links to /setup for first-time setup or
 * retakes. The full wizard lives at /setup.
 */
export function RiskProfileCard() {
  const { profile } = useAuth()

  const completedAt = profile?.riskProfileCompletedAt ?? null

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="dot" className="mb-3">
        Coach Memory
      </EyebrowTag>
      <h3 className="text-lg font-semibold mb-1">Risk Profile</h3>
      <p className="text-sm text-lh-text-dim mb-5">
        {completedAt
          ? 'Your risk preferences are stored in your encrypted MemWal and used by the coach on every session.'
          : 'Answer 5 questions so your coach can advise you properly. Stored in your encrypted MemWal.'}
      </p>

      {completedAt && (
        <p className="text-[11px] font-mono text-lh-text-mute mb-5">
          Completed{' '}
          {new Date(completedAt).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </p>
      )}

      <Link
        to="/setup"
        search={{ next: '/portfolio' }}
        className={cnm(
          'inline-flex items-center gap-2 rounded-full border border-lh-line',
          'text-sm font-medium px-4 py-2 text-lh-text-dim',
          'hover:text-lh-text hover:border-lh-accent/40 transition-colors duration-150',
        )}
      >
        {completedAt ? 'Retake risk profile' : 'Set up risk profile'}
      </Link>
    </Card>
  )
}
