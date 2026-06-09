import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type {
  DryRunPlaceLimitResponse,
  PlaceAsAgentResponse,
  ProfileMe,
} from '@/lib/types'
import type { OrderIntent } from './OrderForm'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  open: boolean
  intent: OrderIntent | null
  profile: ProfileMe
  poolId: string
  baseType: string
  quoteType: string
  onClose: () => void
}

const ORDER_TYPE_GTC = 0
const SELF_MATCHING_ALLOWED = 0
const EXPIRE_NEVER = '18446744073709551615'

type Stage = 'preview' | 'previewing' | 'ready' | 'placing' | 'done' | 'error'

export function ConfirmModal({
  open,
  intent,
  profile,
  poolId,
  baseType,
  quoteType,
  onClose,
}: Props) {
  const qc = useQueryClient()
  const [stage, setStage] = useState<Stage>('preview')
  const [dryRun, setDryRun] = useState<DryRunPlaceLimitResponse | null>(null)
  const [result, setResult] = useState<PlaceAsAgentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setStage('preview')
      setDryRun(null)
      setResult(null)
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open || !intent || stage !== 'preview') return
    runDryRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, intent])

  async function runDryRun() {
    if (!intent) return
    setStage('previewing')
    setError(null)
    try {
      const clientOrderId = String(Date.now())
      const body = {
        suiAddress: profile.suiAddress,
        baseType,
        quoteType,
        clientOrderId,
        orderType: ORDER_TYPE_GTC,
        selfMatching: SELF_MATCHING_ALLOWED,
        price: intent.priceScaled,
        quantity: intent.quantityRaw,
        isBid: intent.side === 'bid',
        payWithDeep: true,
        expireTimestamp: EXPIRE_NEVER,
        poolId,
      }
      const data = await apiFetch<DryRunPlaceLimitResponse>(
        '/sponsor/dry-run-place-limit',
        { method: 'POST', body },
      )
      setDryRun(data)
      setStage('ready')
    } catch (e) {
      setError((e as Error).message ?? 'Dry-run failed')
      setStage('error')
    }
  }

  async function placeOrder() {
    if (!intent) return
    setStage('placing')
    setError(null)
    try {
      // Human-decimal price and quantity — the backend `/trade/place-as-agent`
      // converts these to FLOAT_SCALING'd BigInts. We pass the human values
      // from the OrderForm intent.
      const data = await apiFetch<PlaceAsAgentResponse>(
        '/trade/place-as-agent',
        {
          method: 'POST',
          body: {
            baseType,
            quoteType,
            poolId,
            // Backend expects FLOAT_SCALING'd BigInt strings, not human-decimals.
            price: intent.priceScaled,
            quantity: intent.quantityRaw,
            isBid: intent.side === 'bid',
            payWithDeep: true,
          },
        },
      )
      setResult(data)
      setStage('done')
      void qc.invalidateQueries({ queryKey: ['agent'] })
      void qc.invalidateQueries({ queryKey: ['portfolio'] })
    } catch (e) {
      setError((e as Error).message ?? 'Order placement failed')
      setStage('error')
    }
  }

  if (!open || !intent) return null

  const isBuy = intent.side === 'bid'
  const accent = isBuy ? 'text-emerald-400' : 'text-red-400'
  const willSucceed = dryRun?.willSucceed ?? false

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm order"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative max-w-md w-full bg-lh-bg-elev rounded-3xl border border-lh-line shadow-2xl p-6 md:p-8">
        <h3 className="text-xl font-bold tracking-[-0.02em] mb-1">
          Confirm {isBuy ? 'buy' : 'sell'}
        </h3>
        <p className="text-xs text-lh-text-mute mb-5">
          Atomic PTB signed by your ExecutorAgent · gas sponsored
        </p>

        <div className="rounded-xl bg-lh-bg/40 border border-lh-line p-4 mb-4 space-y-1.5 text-sm">
          <Row
            label="Side"
            value={isBuy ? 'Buy' : 'Sell'}
            valueClass={accent}
          />
          <Row label={`Price (${intent.quoteSymbol})`} value={intent.price} />
          <Row
            label={`Quantity (${intent.baseSymbol})`}
            value={intent.quantity}
          />
        </div>

        <PtbCallList />

        <DryRunBanner stage={stage} willSucceed={willSucceed} dryRun={dryRun} />

        {stage === 'done' && result && (
          <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
            <p className="text-sm text-emerald-400 font-semibold mb-1">
              Order placed
            </p>
            <a
              href={`${config.links.explorerBase}/tx/${result.digest}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-lh-text-dim hover:text-lh-accent break-all"
            >
              {result.digest}
            </a>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-lh-text-dim hover:text-lh-text px-4 py-2"
          >
            {stage === 'done' ? 'Close' : 'Cancel'}
          </button>
          {stage !== 'done' && (
            <button
              type="button"
              disabled={
                !willSucceed || stage === 'placing' || stage === 'previewing'
              }
              onClick={placeOrder}
              className={cnm(
                'rounded-full px-6 py-2.5 text-sm font-semibold',
                !willSucceed || stage === 'placing' || stage === 'previewing'
                  ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
                  : isBuy
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                    : 'bg-red-500 text-white hover:bg-red-600',
              )}
            >
              {stage === 'placing'
                ? 'Placing…'
                : `Place ${isBuy ? 'buy' : 'sell'} order`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PtbCallList() {
  return (
    <div className="mb-4 rounded-xl bg-lh-bg/30 border border-lh-line p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-lh-text-mute mb-2">
        Atomic PTB
      </p>
      <ol className="font-mono text-xs text-lh-text-dim list-decimal pl-5 space-y-0.5">
        <li>executor::place_limit_under_budget</li>
        <li>audit_anchor::record (kind = trade)</li>
        <li>audit_anchor::transfer_to_owner</li>
      </ol>
    </div>
  )
}

function DryRunBanner({
  stage,
  willSucceed,
  dryRun,
}: {
  stage: Stage
  willSucceed: boolean
  dryRun: DryRunPlaceLimitResponse | null
}) {
  if (stage === 'previewing') {
    return <p className="text-xs text-lh-text-mute">Dry-running on testnet…</p>
  }
  if ((stage === 'ready' || stage === 'placing') && dryRun) {
    return (
      <p
        className={cnm(
          'text-xs',
          willSucceed ? 'text-emerald-400' : 'text-red-400',
        )}
      >
        {willSucceed
          ? 'Dry-run succeeded. Safe to place.'
          : `Dry-run failed${dryRun.errorMessage ? ': ' + dryRun.errorMessage : '.'}`}
      </p>
    )
  }
  return null
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-lh-text-mute uppercase tracking-[0.12em] font-mono">
        {label}
      </span>
      <span
        className={cnm(
          'text-sm font-mono tabular-nums text-lh-text',
          valueClass,
        )}
      >
        {value}
      </span>
    </div>
  )
}
