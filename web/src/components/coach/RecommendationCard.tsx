import { useNavigate } from '@tanstack/react-router'

import type { CoachRecommendResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  rec: CoachRecommendResponse
  // / When the user clicks "Apply to trade form", we encode the decision and
  // / hand off to /trade with query params. The /trade page reads them and
  // / pre-fills the OrderForm.
  poolKeyByObjectId?: Record<string, string>
}

/**
 * Renders a single coach recommendation in three columns:
 *   1. Decision (side, price, qty, reasoning)
 *   2. Guardian verdict (pass/fail summary)
 *   3. Verifiable receipt (Atoma hash, Walrus blob, audit anchor)
 *
 * The "Apply to trade form" CTA routes to /trade with the decision encoded
 * in the URL so the user lands one click from sponsored execution.
 */
export function RecommendationCard({ rec, poolKeyByObjectId }: Props) {
  const navigate = useNavigate()

  const explorerBase = config.links.explorerBase
  const walrusUrl = rec.walrusBlobId
    ? `${config.links.walAppUrl ?? 'https://aggregator.walrus-testnet.walrus.space'}/v1/blobs/${rec.walrusBlobId}`
    : null

  // Pool key inference. The coach orchestrator returns the on-chain pool
  // object id; the /trade page expects a friendly key like `SUI_DBUSDC`.
  // We pass through whatever the caller provides and fall back to the
  // raw object id if no mapping exists.
  const poolKey =
    poolKeyByObjectId?.[rec.decision.pool] ??
    poolKeyByObjectId?.[rec.decision.pool.toLowerCase()] ??
    'SUI_DBUSDC'

  function applyToTrade() {
    void navigate({
      to: '/trade',
      search: {
        pool: poolKey,
        side: rec.decision.side === 'bid' ? 'bid' : 'ask',
        price: rec.decision.price,
        quantity: rec.decision.quantity,
        rec: rec.recommendationId,
      } as never,
    })
  }

  return (
    <Card className="p-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* 1. Decision */}
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Coach decision
          </p>
          <div className="flex items-center gap-2 mb-3">
            <span
              className={cnm(
                'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-[0.14em]',
                rec.decision.side === 'bid'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-red-500/15 text-red-300',
              )}
            >
              {rec.decision.side === 'bid' ? 'Buy' : 'Sell'}
            </span>
            <span className="font-mono text-xs text-lh-text-dim truncate">
              {poolKey}
            </span>
          </div>
          <p className="text-2xl font-semibold tabular-nums tracking-[-0.01em] mb-1">
            {rec.decision.quantity}
          </p>
          <p className="text-sm text-lh-text-dim mb-3">
            @ <span className="tabular-nums">{rec.decision.price}</span>
          </p>
          {rec.decision.reasoning && (
            <p className="text-sm text-lh-text leading-relaxed">
              {rec.decision.reasoning}
            </p>
          )}
        </div>

        {/* 2. Guardian */}
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Guardian verdict
          </p>
          <div className="flex items-center gap-2 mb-3">
            <span
              className={cnm(
                'inline-block w-2 h-2 rounded-full',
                rec.guardian.overall_pass ? 'bg-emerald-400' : 'bg-red-400',
              )}
              aria-hidden="true"
            />
            <span
              className={cnm(
                'text-sm font-semibold',
                rec.guardian.overall_pass ? 'text-emerald-300' : 'text-red-300',
              )}
            >
              {rec.guardian.overall_pass ? 'Passed' : 'Blocked'}
            </span>
          </div>
          <p className="text-sm text-lh-text-dim leading-relaxed">
            {rec.guardian.summary}
          </p>
          {rec.guardian.checks && rec.guardian.checks.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-xs">
              {rec.guardian.checks.map((c) => (
                <li key={c.name} className="flex items-baseline gap-2">
                  <span
                    className={cnm(
                      'font-mono uppercase tracking-[0.14em] text-[10px] shrink-0',
                      c.pass ? 'text-emerald-300' : 'text-red-300',
                    )}
                  >
                    {c.pass ? '✓' : '✗'}
                  </span>
                  <span className="text-lh-text-dim">
                    <span className="font-mono">{c.name}</span>
                    {c.detail ? ` — ${c.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 3. Verifiable receipt */}
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Verifiable receipt
          </p>
          <dl className="space-y-2 text-xs">
            <Row label="Atoma model" value={rec.atomaModel} />
            <Row
              label="Request hash"
              value={rec.atomaRequestHash.slice(0, 12) + '…'}
              mono
            />
            {rec.walrusBlobId && (
              <Row
                label="Walrus blob"
                value={rec.walrusBlobId.slice(0, 12) + '…'}
                mono
                href={walrusUrl ?? undefined}
              />
            )}
            {rec.auditAnchorTxDigest && (
              <Row
                label="Audit anchor"
                value={rec.auditAnchorTxDigest.slice(0, 12) + '…'}
                mono
                href={`${explorerBase}/tx/${rec.auditAnchorTxDigest}`}
              />
            )}
          </dl>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={applyToTrade}
              className={cnm(
                'inline-flex items-center justify-center gap-2 rounded-full',
                'bg-lh-accent text-lh-bg font-semibold',
                'text-sm px-4 py-2 leading-none',
                'hover:bg-lh-accent-warm transition-colors duration-150',
              )}
            >
              Apply to trade form
            </button>
            <a
              href={`/receipt/${rec.recommendationId}`}
              className="inline-flex items-center justify-center gap-2 rounded-full text-xs text-lh-text-dim hover:text-lh-text px-4 py-1.5 border border-lh-line"
            >
              Open verifiable receipt →
            </a>
          </div>
        </div>
      </div>
    </Card>
  )
}

function Row({
  label,
  value,
  href,
  mono,
}: {
  label: string
  value: string
  href?: string
  mono?: boolean
}) {
  const valueClass = cnm(
    'truncate',
    mono ? 'font-mono tabular-nums' : '',
    href
      ? 'text-lh-accent hover:underline underline-offset-4'
      : 'text-lh-text-dim',
  )
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-lh-text-mute uppercase tracking-[0.12em] font-mono text-[10px] shrink-0">
        {label}
      </dt>
      <dd className={valueClass}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
