import { cnm } from '@/utils/style'
import { Card } from '@/components/ui/Card'
import { StatusPulseDot } from '@/components/ui/StatusPulseDot'

type TrustCardStatus = 'live' | 'testnet' | 'pending' | 'warning'

interface TrustCardProps {
  status: TrustCardStatus
  label: string
  body: string
}

export function TrustCard({ status, label, body }: TrustCardProps) {
  return (
    <Card
      className={cnm(
        'transition-shadow duration-[var(--dur-fast)] ease-[var(--ease-sui)]',
        'hover:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_32px_rgb(0_0_0/0.06),inset_0_0_0_1px_rgb(251_191_36_/_0.3)]',
        'dark:hover:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_8px_32px_rgb(0_0_0/0.3),inset_0_0_0_1px_rgb(251_191_36_/_0.3)]',
        status === 'warning' && 'border-l-2 border-l-lh-accent rounded-l-none',
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        {status === 'live' && <StatusPulseDot label={label} />}
        {status === 'testnet' && (
          <>
            <div
              className="w-2 h-2 rounded-full bg-lh-accent shrink-0"
              aria-hidden="true"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
              {label}
            </span>
          </>
        )}
        {status === 'pending' && (
          <>
            <div
              className="w-2 h-2 rounded-full bg-lh-text-mute shrink-0"
              aria-hidden="true"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
              {label}
            </span>
          </>
        )}
        {status === 'warning' && (
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
            {label}
          </span>
        )}
      </div>
      <p className="text-sm text-lh-text-dim leading-relaxed">{body}</p>
    </Card>
  )
}
