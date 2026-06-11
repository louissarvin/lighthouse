import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { AgentBalancesResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

function shortId(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return '—'
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

function isNonZero(val: string | null | undefined): boolean {
  if (!val) return false
  try {
    return parseFloat(val) > 0
  } catch {
    return false
  }
}

interface BalanceRowProps {
  label: string
  value: string
}

function BalanceRow({ label, value }: BalanceRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute">
        {label}
      </span>
      <span className="font-mono text-sm tabular-nums text-lh-text-dim">
        {value}
      </span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-2">
      {children}
    </p>
  )
}

export function BalancesCard() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<AgentBalancesResponse>({
    queryKey: ['agent', 'balances'],
    queryFn: () => apiFetch<AgentBalancesResponse>('/agent/balances'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: ['agent', 'balances'] })
  }

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-center justify-between mb-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute">
          Balances
        </p>
        <button
          type="button"
          onClick={handleRefresh}
          className="text-[10px] font-mono uppercase tracking-[0.12em] text-lh-text-mute hover:text-lh-text transition-colors border border-lh-line rounded-full px-2.5 py-1"
          aria-label="Refresh balances"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : (
        <div className="space-y-0">
          {/* BalanceManager */}
          <div className="pb-4 border-b border-lh-line">
            <SectionLabel>BalanceManager</SectionLabel>
            {data?.balanceManager.available ? (
              <>
                <BalanceRow
                  label="SUI"
                  value={data.balanceManager.sui ?? '—'}
                />
                <BalanceRow
                  label="DBUSDC"
                  value={data.balanceManager.dbusdc ?? '—'}
                />
                {data.balanceManager.objectId && (
                  <a
                    href={`https://suiscan.xyz/testnet/object/${data.balanceManager.objectId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cnm(
                      'inline-block mt-1.5 font-mono text-[10px] text-lh-text-mute',
                      'hover:text-lh-accent transition-colors',
                    )}
                  >
                    {shortId(data.balanceManager.objectId)} ↗
                  </a>
                )}
              </>
            ) : (
              <p className="text-xs text-lh-text-mute">Not set up</p>
            )}
          </div>

          {/* PredictManager */}
          <div className="py-4 border-b border-lh-line">
            <SectionLabel>PredictManager</SectionLabel>
            {data?.predictManager.available ? (
              <>
                <BalanceRow
                  label="DUSDC"
                  value={data.predictManager.dusdc ?? '—'}
                />
                {data.predictManager.positionCount > 0 && (
                  <BalanceRow
                    label="Positions"
                    value={`${data.predictManager.positionCount} open`}
                  />
                )}
              </>
            ) : (
              <p className="text-xs text-lh-text-mute">Not set up</p>
            )}
          </div>

          {/* Wallet */}
          <div className="pt-4">
            <SectionLabel>Wallet</SectionLabel>
            {data?.wallet && (
              <>
                <BalanceRow label="SUI" value={data.wallet.sui} />
                {isNonZero(data.wallet.dusdc) && (
                  <BalanceRow label="DUSDC" value={data.wallet.dusdc} />
                )}
                <a
                  href={`https://suiscan.xyz/testnet/account/${data.wallet.suiAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cnm(
                    'inline-block mt-1.5 font-mono text-[10px] text-lh-text-mute',
                    'hover:text-lh-accent transition-colors',
                  )}
                >
                  {shortId(data.wallet.suiAddress)} ↗
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
