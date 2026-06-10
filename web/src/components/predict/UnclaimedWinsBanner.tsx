import { useQuery } from '@tanstack/react-query'

import type { PredictPositionsResponse } from '@/lib/types'
import { ApiError, apiFetch } from '@/lib/api'

interface Props {
  managerId: string | null
}

export function UnclaimedWinsBanner({ managerId }: Props) {
  const { data } = useQuery<PredictPositionsResponse>({
    queryKey: ['predict', 'positions', managerId ?? ''],
    queryFn: async () => {
      if (!managerId) return { positions: [], stale: true }
      try {
        return await apiFetch<PredictPositionsResponse>(
          `/predict/positions/${encodeURIComponent(managerId)}`,
        )
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return { positions: [], stale: true }
        }
        throw e
      }
    },
    enabled: !!managerId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const settledCount = (data?.positions ?? []).filter(
    (p) => p.status === 'settled',
  ).length

  if (!managerId || settledCount === 0) return null

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
      <span className="text-lg leading-none mt-0.5" aria-hidden="true">
        🏆
      </span>
      <div>
        <p className="text-sm text-amber-200/90 font-medium">
          You have {settledCount} won{' '}
          {settledCount === 1 ? 'position' : 'positions'} ready to claim.
        </p>
        <p className="text-xs text-amber-200/60 mt-0.5">
          Scroll down to Positions and click Claim.
        </p>
      </div>
    </div>
  )
}
