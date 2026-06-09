import { useEffect, useMemo, useState } from 'react'

import type {
  AgentSnapshotResponse,
  OrderBookSnapshot,
  ProfileMe,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'

export interface OrderIntent {
  side: 'bid' | 'ask'
  price: string
  quantity: string
  // / Display only — quote currency symbol (DBUSDC / SUI etc.).
  quoteSymbol: string
  baseSymbol: string
  // / FLOAT_SCALING'd (1e9) string for transport to backend.
  priceScaled: string
  // / Raw base units string.
  quantityRaw: string
  // / FLOAT_SCALING'd notional string (price * qty / scalar_qty).
  notionalScaled: string
}

interface Props {
  profile: ProfileMe
  agent: AgentSnapshotResponse | null
  book: OrderBookSnapshot | null
  // / Optional price seed (e.g. picked from order book — INVERTS side because
  // / clicking an ask means the user wants to buy and vice versa).
  presetPrice?: { price: string; side: 'bid' | 'ask' } | null
  // / Optional direct-from-coach seed. Side is NOT inverted (coach said
  // / "buy", form should show "buy"). Quantity is also seeded.
  coachIntent?: { price: string; side: 'bid' | 'ask'; quantity: string } | null
  onSubmit: (intent: OrderIntent) => void
  pending?: boolean
}

const FLOAT_SCALING = 1_000_000_000

function safeBig(s: string | undefined | null): bigint | null {
  if (!s) return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

export function OrderForm({
  profile,
  agent,
  book,
  presetPrice,
  coachIntent,
  onSubmit,
  pending,
}: Props) {
  const [side, setSide] = useState<'bid' | 'ask'>('bid')
  const [priceInput, setPriceInput] = useState<string>('')
  const [qtyInput, setQtyInput] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Apply preset (picked from order book).
  useEffect(() => {
    if (presetPrice?.price) {
      setPriceInput(presetPrice.price)
      // Inverting side: clicking an ask price means user wants to buy at that
      // price (bid). Clicking a bid price means user wants to sell at that
      // price (ask). Mirrors most pro UIs.
      setSide(presetPrice.side === 'ask' ? 'bid' : 'ask')
    }
  }, [presetPrice])

  // Coach handoff — do NOT invert side; coach already speaks the user's intent.
  useEffect(() => {
    if (!coachIntent) return
    setPriceInput(coachIntent.price)
    setQtyInput(coachIntent.quantity)
    setSide(coachIntent.side)
  }, [coachIntent])

  // Seed price with mid on first book arrival if user hasn't typed.
  useEffect(() => {
    if (!priceInput && book?.mid) setPriceInput(book.mid)
  }, [book?.mid, priceInput])

  const baseSymbol = book?.base ?? '—'
  const quoteSymbol = book?.quote ?? '—'

  const calc = useMemo(() => {
    const priceN = Number(priceInput)
    const qtyN = Number(qtyInput)
    if (
      !Number.isFinite(priceN) ||
      !Number.isFinite(qtyN) ||
      priceN <= 0 ||
      qtyN <= 0
    ) {
      return null
    }
    const notional = priceN * qtyN
    // FLOAT_SCALING'd price (1e9 * price). Quantity scaled by base decimals.
    const baseScalar = Math.pow(10, book?.baseDecimals ?? 9)
    const priceScaled = BigInt(Math.floor(priceN * FLOAT_SCALING))
    const quantityRaw = BigInt(Math.floor(qtyN * baseScalar))
    // notional in FLOAT_SCALING'd quote = priceScaled * quantityRaw / baseScalar
    // matches the Move-side budget unit used by `executor::place_limit_under_budget`.
    const notionalScaled = (priceScaled * quantityRaw) / BigInt(baseScalar)
    return { notional, priceScaled, quantityRaw, notionalScaled }
  }, [priceInput, qtyInput, book?.baseDecimals])

  const validation = useMemo(() => {
    if (!agent?.ready || !agent.snapshot) {
      return { ok: false, reason: 'No executor agent yet.' }
    }
    if (agent.snapshot.revoked) {
      return { ok: false, reason: 'Executor agent revoked.' }
    }
    if (!calc) return { ok: false, reason: null }

    const maxPerTrade = safeBig(agent.snapshot.max_notional_per_trade)
    const maxPerDay = safeBig(agent.snapshot.max_notional_per_day)
    const spent = safeBig(agent.snapshot.spent_today)
    if (maxPerTrade !== null && calc.notionalScaled > maxPerTrade) {
      return {
        ok: false,
        reason: `Above per-trade cap (${(Number(maxPerTrade) / FLOAT_SCALING).toFixed(2)} ${quoteSymbol}).`,
      }
    }
    if (
      maxPerDay !== null &&
      spent !== null &&
      calc.notionalScaled + spent > maxPerDay
    ) {
      return {
        ok: false,
        reason: 'Above remaining daily budget.',
      }
    }
    return { ok: true, reason: null }
  }, [agent, calc, quoteSymbol])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!calc) {
      setError('Enter a price and quantity.')
      return
    }
    if (!validation.ok) {
      setError(validation.reason ?? 'Order not allowed.')
      return
    }
    onSubmit({
      side,
      price: priceInput,
      quantity: qtyInput,
      baseSymbol,
      quoteSymbol,
      priceScaled: calc.priceScaled.toString(),
      quantityRaw: calc.quantityRaw.toString(),
      notionalScaled: calc.notionalScaled.toString(),
    })
  }

  const disabled = !validation.ok || pending || !profile.executorAgentId

  return (
    <Card className="p-6 md:p-8">
      <div className="mb-5">
        <h3 className="text-lg font-semibold mb-1">Place limit</h3>
        <p className="text-xs text-lh-text-mute">
          One atomic PTB. Sponsored gas. Anchor receipt bundled.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Order side"
        className="grid grid-cols-2 gap-2 mb-5 p-1 rounded-full bg-lh-bg/40 border border-lh-line"
      >
        <button
          role="tab"
          aria-selected={side === 'bid'}
          type="button"
          onClick={() => setSide('bid')}
          className={cnm(
            'rounded-full py-2 text-sm font-semibold transition-colors',
            side === 'bid'
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'text-lh-text-mute hover:text-lh-text',
          )}
        >
          Buy
        </button>
        <button
          role="tab"
          aria-selected={side === 'ask'}
          type="button"
          onClick={() => setSide('ask')}
          className={cnm(
            'rounded-full py-2 text-sm font-semibold transition-colors',
            side === 'ask'
              ? 'bg-red-500/15 text-red-400'
              : 'text-lh-text-mute hover:text-lh-text',
          )}
        >
          Sell
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label={`Price (${quoteSymbol})`}
          value={priceInput}
          onChange={setPriceInput}
          inputMode="decimal"
          placeholder={book?.mid ?? '0.0000'}
        />
        <Field
          label={`Quantity (${baseSymbol})`}
          value={qtyInput}
          onChange={setQtyInput}
          inputMode="decimal"
          placeholder="0.00"
        />

        <div className="rounded-xl border border-lh-line bg-lh-bg/40 px-4 py-3 text-sm">
          <Row label="Side" value={side === 'bid' ? 'Buy' : 'Sell'} />
          <Row
            label={`Notional (${quoteSymbol})`}
            value={
              calc
                ? calc.notional.toLocaleString('en-US', {
                    maximumFractionDigits: 4,
                  })
                : '—'
            }
          />
          {agent?.snapshot && (
            <Row
              label="Per-trade cap"
              value={`${(Number(agent.snapshot.max_notional_per_trade) / FLOAT_SCALING).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${quoteSymbol}`}
            />
          )}
        </div>

        {validation.reason && (
          <p className="text-xs text-amber-400" role="alert">
            {validation.reason}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={disabled}
          className={cnm(
            'w-full rounded-full py-3 text-sm font-semibold transition-colors',
            'focus-visible:outline-2 focus-visible:outline-lh-focus-ring focus-visible:outline-offset-2',
            disabled
              ? 'bg-lh-bg/30 text-lh-text-mute border border-lh-line cursor-not-allowed'
              : side === 'bid'
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : 'bg-red-500 text-white hover:bg-red-600',
          )}
        >
          {pending
            ? 'Preparing…'
            : `Preview ${side === 'bid' ? 'buy' : 'sell'}`}
        </button>
      </form>
    </Card>
  )
}

type FieldProps = {
  label: string
  value: string
  onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>

function Field({ label, value, onChange, ...rest }: FieldProps) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-[0.12em] font-mono text-lh-text-mute mb-1.5">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        className={cnm(
          'w-full rounded-xl border border-lh-line bg-lh-bg/60',
          'px-4 py-2.5 text-base font-mono tabular-nums',
          'text-lh-text placeholder:text-lh-text-mute',
          'focus:outline-none focus:border-lh-accent transition-colors',
        )}
      />
    </label>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-xs text-lh-text-mute uppercase tracking-[0.12em] font-mono">
        {label}
      </span>
      <span className="text-sm font-mono tabular-nums text-lh-text-dim">
        {value}
      </span>
    </div>
  )
}
