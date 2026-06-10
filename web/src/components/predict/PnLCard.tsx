import { useQuery } from '@tanstack/react-query'

import type { PredictPnLResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

function StreakPill({ streak }: { streak: PredictPnLResponse['streak'] }) {
  if (!streak) return null
  const positive = streak === 'win_streak' || streak === 'positive_run'
  const label =
    streak === 'win_streak'
      ? 'Win streak'
      : streak === 'positive_run'
        ? 'Positive run'
        : streak === 'loss_streak'
          ? 'Loss streak'
          : 'Negative run'
  return (
    <span
      className={cnm(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.12em]',
        positive
          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
          : 'bg-red-500/10 text-red-400 border border-red-500/25',
      )}
    >
      {label}
    </span>
  )
}

interface StatCellProps {
  label: string
  value: string
  className?: string
}

function StatCell({ label, value, className }: StatCellProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
        {label}
      </p>
      <p className={cnm('text-xl font-semibold tabular-nums', className)}>
        {value}
      </p>
    </div>
  )
}

export function PnLCard() {
  const { data, isLoading } = useQuery<PredictPnLResponse>({
    queryKey: ['predict', 'pnl'],
    queryFn: () => apiFetch<PredictPnLResponse>('/predict/pnl'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-start justify-between mb-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute">
          Prediction P&L
        </p>
        {data?.streak && <StreakPill streak={data.streak} />}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 mb-7">
            <StatCell
              label="Won"
              value={data?.winRate !== null ? String(data?.won ?? 0) : '--'}
              className="text-emerald-400"
            />
            <StatCell
              label="Lost"
              value={data?.winRate !== null ? String(data?.lost ?? 0) : '--'}
              className="text-lh-text-dim"
            />
            <StatCell
              label="Open"
              value={String(data?.open ?? '--')}
              className="text-lh-accent"
            />
            <StatCell
              label="Redeemed"
              value={
                data?.winRate !== null ? String(data?.redeemed ?? 0) : '--'
              }
              className="text-lh-text-dim"
            />
          </div>

          <div className="mb-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-1">
              Win rate
            </p>
            <p className="text-4xl font-bold tabular-nums tracking-[-0.02em]">
              {data?.winRate !== null && data?.winRate !== undefined
                ? `${data.winRate}%`
                : '--'}
            </p>
          </div>

          <p className="text-xs text-lh-text-mute tabular-nums">
            Total wagered:{' '}
            <span className="text-lh-text-dim">
              {data?.totalWageredDusdc ?? '--'} DUSDC
            </span>
          </p>
        </>
      )}
    </Card>
  )
}
