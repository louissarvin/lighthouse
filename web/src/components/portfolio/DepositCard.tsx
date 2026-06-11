import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  DepositInstantResponse,
  PendingDepositCreatedResponse,
  PendingDepositRow,
  ProfileMe,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  profile: ProfileMe | null
}

function mistToSui(mist: string): string {
  try {
    return (Number(BigInt(mist)) / 1e9).toFixed(4)
  } catch {
    return mist
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    awaiting: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    swept: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
    failed: 'text-red-300 bg-red-500/10 border-red-500/30',
    expired: 'text-lh-text-mute bg-lh-bg/40 border-lh-line',
  }
  const cls = map[status] ?? 'text-lh-text-mute border-lh-line bg-lh-bg/40'
  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        cls,
      )}
    >
      {status === 'swept' && (
        <span aria-hidden="true" className="text-[8px]">
          ✓
        </span>
      )}
      {status}
    </span>
  )
}

export function DepositCard({ profile }: Props) {
  const qc = useQueryClient()
  const hasDepositCap = !!profile?.depositCapId
  const hasBalanceManager = !!profile?.balanceManagerId

  // Instant deposit (existing, working)
  const [amount, setAmount] = useState('1.0')
  const [executorAddress, setExecutorAddress] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [instantSuccess, setInstantSuccess] = useState<string | null>(null)
  const [instantError, setInstantError] = useState<string | null>(null)

  // Auto-sweep deposit (new flow)
  const [sweepAmount, setSweepAmount] = useState('1.0')
  const [pendingCreated, setPendingCreated] =
    useState<PendingDepositCreatedResponse | null>(null)
  const [sweepError, setSweepError] = useState<string | null>(null)

  // Always fetch executor address
  useEffect(() => {
    let cancelled = false
    apiFetch<{ executorAddress: string }>('/agent/executor-address')
      .then((r) => {
        if (!cancelled) setExecutorAddress(r.executorAddress)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Poll pending deposits every 5s
  const { data: pendingDeposits } = useQuery<Array<PendingDepositRow>>({
    queryKey: ['agent', 'pending-deposits'],
    queryFn: () =>
      apiFetch<Array<PendingDepositRow>>('/agent/pending-deposits'),
    refetchInterval: 5_000,
    staleTime: 4_000,
    enabled: !!profile,
  })

  // Instant deposit mutation
  const instantMutation = useMutation({
    mutationFn: async () => {
      const amountNum = parseFloat(amount)
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        throw new Error('Enter a valid amount')
      }
      const amountMist = Math.floor(amountNum * 1e9).toString()
      return apiFetch<DepositInstantResponse>('/agent/deposit-instant', {
        method: 'POST',
        body: { amountMist },
      })
    },
    onSuccess: (resp) => {
      setInstantSuccess(resp.digest)
      setInstantError(null)
      void qc.invalidateQueries({ queryKey: ['agent', 'snapshot'] })
    },
    onError: (e) => {
      setInstantError((e).message)
    },
  })

  // Create pending deposit intent mutation
  const sweepMutation = useMutation({
    mutationFn: async () => {
      const amountNum = parseFloat(sweepAmount)
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        throw new Error('Enter a valid amount')
      }
      const amountMist = Math.floor(amountNum * 1e9).toString()
      return apiFetch<PendingDepositCreatedResponse>('/agent/pending-deposit', {
        method: 'POST',
        body: { amountMist },
      })
    },
    onSuccess: (resp) => {
      setPendingCreated(resp)
      setSweepError(null)
      void qc.invalidateQueries({ queryKey: ['agent', 'pending-deposits'] })
    },
    onError: (e) => {
      setSweepError((e).message)
    },
  })

  async function copyAddress(addr: string) {
    try {
      await navigator.clipboard.writeText(addr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API unavailable — silently ignore
    }
  }

  const displayAddress = pendingCreated?.executorAddress ?? executorAddress

  return (
    <Card className="p-6 md:p-8">
      <EyebrowTag prefix="none" className="mb-3">
        Deposit
      </EyebrowTag>
      <h3 className="text-lg font-semibold mb-1">
        Add SUI to your Balance Manager
      </h3>

      {/* Executor address display */}
      <div className="mb-6 mt-4">
        <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
          Executor address
        </span>
        <div className="flex items-center gap-2">
          <span
            className={cnm(
              'flex-1 font-mono text-xs rounded-xl border border-lh-line',
              'bg-lh-bg/60 px-4 py-2.5 text-lh-text-dim break-all',
            )}
          >
            {displayAddress ?? '…'}
          </span>
          <button
            type="button"
            onClick={() => displayAddress && void copyAddress(displayAddress)}
            disabled={!displayAddress}
            className={cnm(
              'shrink-0 rounded-lg border border-lh-line px-3 py-2',
              'text-xs font-mono text-lh-text-mute hover:text-lh-text transition-colors',
              !displayAddress && 'opacity-40 cursor-not-allowed',
            )}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Auto-sweep flow */}
      <div className="mb-6">
        <p className="text-sm text-lh-text-dim mb-4">
          Send SUI to the address above, then click below. We'll auto-credit
          your BalanceManager when the transfer arrives (within 30 minutes).
        </p>

        <label className="block mb-4">
          <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
            Amount (SUI)
          </span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={sweepAmount}
              onChange={(e) => setSweepAmount(e.target.value)}
              disabled={sweepMutation.isPending}
              className={cnm(
                'w-full rounded-xl border border-lh-line bg-lh-bg/60',
                'px-4 py-2.5 text-base font-mono tabular-nums',
                'text-lh-text placeholder:text-lh-text-mute',
                'focus:outline-none focus:border-lh-accent transition-colors',
                sweepMutation.isPending && 'opacity-50 cursor-not-allowed',
              )}
              placeholder="1.0"
            />
            <span className="font-mono text-sm text-lh-text-mute shrink-0">
              SUI
            </span>
          </div>
        </label>

        {pendingCreated ? (
          <div className="rounded-xl border border-lh-accent/30 bg-lh-accent/5 px-4 py-3 text-sm">
            <p className="text-lh-accent font-semibold mb-1">
              Send {mistToSui(pendingCreated.amountMist)} SUI to the address
              above within 30 minutes.
            </p>
            <p className="text-xs text-lh-text-dim">
              We'll auto-credit your BalanceManager when it arrives.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => sweepMutation.mutate()}
            disabled={sweepMutation.isPending || !profile || !hasBalanceManager}
            className={cnm(
              'w-full rounded-full py-3 text-sm font-semibold transition-colors',
              'bg-lh-accent text-lh-bg hover:bg-lh-accent-warm',
              (sweepMutation.isPending || !profile || !hasBalanceManager) &&
                'opacity-50 cursor-not-allowed',
            )}
          >
            {sweepMutation.isPending ? 'Creating intent…' : "I'll send it"}
          </button>
        )}

        {sweepError && (
          <p className="mt-2 text-xs text-red-400" role="alert">
            {sweepError}
          </p>
        )}
        {!hasBalanceManager && (
          <p className="mt-2 text-xs text-lh-text-mute">
            Complete onboarding first to enable deposits.
          </p>
        )}
      </div>

      {/* Live status list */}
      {pendingDeposits && pendingDeposits.length > 0 && (
        <div className="border-t border-lh-line pt-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-3">
            Deposit intents
          </p>
          <ul className="space-y-2">
            {pendingDeposits.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-mono text-lh-text tabular-nums">
                    {mistToSui(row.amountMist)} SUI
                  </p>
                  <p className="text-lh-text-mute">
                    {relativeTime(row.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={row.status} />
                  {row.sweptTxDigest && (
                    <a
                      href={`${config.links.explorerBase}/tx/${row.sweptTxDigest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[10px] text-lh-accent hover:underline"
                    >
                      tx ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Instant deposit (only available when depositCap is set) */}
      {hasDepositCap && (
        <div className="border-t border-lh-line pt-5 mt-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-3">
            Instant deposit (DepositCap)
          </p>
          <p className="text-xs text-lh-text-dim mb-4">
            You have a DepositCap configured. Deposit directly without waiting
            for sweep detection.
          </p>
          <label className="block mb-4">
            <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-lh-text-mute mb-1.5">
              Amount (SUI)
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={instantMutation.isPending}
                className={cnm(
                  'w-full rounded-xl border border-lh-line bg-lh-bg/60',
                  'px-4 py-2.5 text-base font-mono tabular-nums',
                  'text-lh-text placeholder:text-lh-text-mute',
                  'focus:outline-none focus:border-lh-accent transition-colors',
                  instantMutation.isPending && 'opacity-50 cursor-not-allowed',
                )}
                placeholder="1.0"
              />
              <span className="font-mono text-sm text-lh-text-mute shrink-0">
                SUI
              </span>
            </div>
          </label>
          {instantSuccess ? (
            <p className="text-sm text-emerald-400">
              Deposited.{' '}
              <a
                href={`${config.links.explorerBase}/tx/${instantSuccess}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View tx
              </a>
            </p>
          ) : (
            <button
              type="button"
              onClick={() => instantMutation.mutate()}
              disabled={
                instantMutation.isPending ||
                !executorAddress ||
                !hasBalanceManager
              }
              className={cnm(
                'w-full rounded-full py-3 text-sm font-semibold transition-colors',
                'bg-lh-accent text-lh-bg hover:bg-lh-accent-warm',
                (instantMutation.isPending ||
                  !executorAddress ||
                  !hasBalanceManager) &&
                  'opacity-50 cursor-not-allowed',
              )}
            >
              {instantMutation.isPending ? 'Depositing…' : 'Deposit Now'}
            </button>
          )}
          {instantError && (
            <p className="mt-3 text-xs text-red-400" role="alert">
              {instantError}
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
