import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight } from 'lucide-react'

import { useAuth } from '@/hooks/useAuth'
import { cnm } from '@/utils/style'

/**
 * Non-blocking banner that surfaces when the user's trading bootstrap
 * (BalanceManager + ExecutorAgent + MemWal) is incomplete. Honest about
 * what's missing instead of silently failing on the next sponsored PTB.
 *
 * Rendered above the page content on /trade, /coach, /predict. Returns null
 * when there is no profile (unauthed routes never mount it) or when all
 * essentials are present.
 *
 * Recovery flow is documented on /onboarding: the auto-bootstrap can only
 * be re-run inside a fresh OAuth callback because it needs the ephemeral
 * zkLogin keys, so the CTA chains through /auth.
 */
interface Props {
  // / When `true`, the banner uses tighter padding for in-page contexts.
  compact?: boolean
  className?: string
}

export function OnboardingBanner({ compact = false, className }: Props) {
  const { profile } = useAuth()
  if (!profile) return null

  const missing: Array<string> = []
  if (!profile.balanceManagerId) missing.push('BalanceManager')
  if (!profile.executorAgentId) missing.push('Executor agent')
  if (!profile.memwalAccountId) missing.push('MemWal account')

  if (missing.length === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cnm(
        'rounded-2xl border border-amber-500/30 bg-amber-500/[0.04]',
        'flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5',
        compact ? 'px-4 py-3' : 'px-5 py-4',
        className,
      )}
    >
      <AlertTriangle
        size={18}
        strokeWidth={1.5}
        className="text-amber-400 shrink-0"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold mb-0.5">
          Trading bootstrap incomplete
        </p>
        <p className="text-xs text-lh-text-dim leading-relaxed">
          Missing: <span className="font-mono">{missing.join(' · ')}</span>. You
          can browse, but signed actions will fail until setup finishes.
        </p>
      </div>
      <Link
        to="/onboarding"
        className={cnm(
          'inline-flex items-center gap-1.5 rounded-full',
          'bg-amber-500 text-lh-bg font-semibold text-xs px-3.5 py-2',
          'hover:bg-amber-400 transition-colors shrink-0',
        )}
      >
        Open status
        <ArrowRight size={12} strokeWidth={2.2} />
      </Link>
    </div>
  )
}
