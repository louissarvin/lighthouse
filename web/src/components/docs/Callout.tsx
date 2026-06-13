// TODO: replace with --color-lh-warn and --color-lh-danger tokens in Phase 2
// Status color tokens (success/danger/warn/info) are deferred to Phase 2
// per IMPLEMENTATION_SPEC §2 Resolved 4. Raw hex values are temporary.

import { cnm } from '@/utils/style'

type CalloutVariant = 'info' | 'warn' | 'danger' | 'note'

const VARIANT_STYLES: Record<CalloutVariant, string> = {
  info: 'border-l-2 border-lh-accent bg-lh-bg-elev',
  warn: 'border-l-2 border-[#F59E0B] bg-lh-bg-elev',
  danger: 'border-l-2 border-[#EF4444] bg-lh-bg-elev',
  note: 'border-l-2 border-lh-line-mid bg-lh-bg-elev',
}

const VARIANT_EYEBROW: Record<CalloutVariant, string> = {
  info: 'INFO',
  warn: 'WARNING',
  danger: 'CRITICAL',
  note: 'NOTE',
}

interface CalloutProps {
  variant?: CalloutVariant
  children: React.ReactNode
}

export function Callout({ variant = 'note', children }: CalloutProps) {
  return (
    <div className={cnm('rounded-r my-6 px-5 py-4', VARIANT_STYLES[variant])}>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
        {VARIANT_EYEBROW[variant]}
      </p>
      <div className="text-sm text-lh-text-dim leading-[1.65]">{children}</div>
    </div>
  )
}
