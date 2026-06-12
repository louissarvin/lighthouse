import type { TearsheetResponse } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { config } from '@/config'

interface Props {
  data: TearsheetResponse
}

function fmtUSDC(s: string | null): string {
  if (!s) return '—'
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  return n.toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    })
  } catch {
    return iso
  }
}

export function TearsheetCard({ data }: Props) {
  const explorer = config.links.explorerBase
  const ownerLabel =
    data.suins_name ??
    `${data.sui_address.slice(0, 8)}…${data.sui_address.slice(-6)}`

  return (
    <div className="space-y-6">
      <Card className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
              Weekly tearsheet · {data.week}
            </p>
            <h1 className="text-3xl md:text-[40px] font-bold tracking-[-0.03em] mb-2 truncate">
              {ownerLabel}
            </h1>
            <p className="text-sm text-lh-text-dim leading-relaxed">
              {fmtDate(data.window_from)} → {fmtDate(data.window_to)}
            </p>
          </div>
          <a
            href={data.publicTearsheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cnm(
              'inline-flex items-center gap-2 rounded-full',
              'border border-lh-line bg-lh-bg/40 px-4 py-2',
              'text-xs font-mono uppercase tracking-[0.14em] text-lh-text-dim',
              'hover:text-lh-text hover:border-lh-accent/50 transition-colors',
            )}
          >
            Raw JSON on Walrus
          </a>
        </div>

        <dl className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Metric label="Trades" value={data.total_trades?.toString() ?? '—'} />
          <Metric
            label="Notional (USDC)"
            value={fmtUSDC(data.total_notional_usdc)}
            mono
          />
          <Metric
            label="Pools"
            value={data.distinct_pools?.toString() ?? '—'}
          />
          <Metric
            label="Anchor digest"
            value={
              data.auditAnchorTxDigest
                ? data.auditAnchorTxDigest.slice(0, 10) + '…'
                : '—'
            }
            mono
            href={
              data.auditAnchorTxDigest
                ? `${explorer}/tx/${data.auditAnchorTxDigest}`
                : undefined
            }
          />
        </dl>
      </Card>

      {/* Honest-disclosure note from backend (deferred PnL math). */}
      <Card className="p-5 border border-amber-500/30 bg-amber-500/5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-amber-300 mb-2">
          Disclosure
        </p>
        <p className="text-sm text-lh-text-dim leading-relaxed">
          {data.disclaimer}
        </p>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Walrus blob
          </p>
          <p className="font-mono text-xs text-lh-text break-all">
            {data.walrus_blob_id}
          </p>
          <p className="mt-3 text-[11px] text-lh-text-mute leading-relaxed">
            This blob lives on the Walrus aggregator. Re-fetching it years from
            now from any aggregator URL returns the same bytes — that's the
            audit trail outliving the app.
          </p>
        </Card>

        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Address
          </p>
          <p className="font-mono text-xs text-lh-text break-all">
            <a
              href={`${explorer}/account/${data.sui_address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-lh-accent"
            >
              {data.sui_address}
            </a>
          </p>
          {data.suins_name && (
            <p className="mt-2 text-[11px] text-lh-text-mute">
              Resolves to <span className="font-mono">{data.suins_name}</span>{' '}
              via SuiNS.
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  mono,
  href,
}: {
  label: string
  value: string
  mono?: boolean
  href?: string
}) {
  return (
    <div>
      <dt className="font-mono uppercase tracking-[0.12em] text-[10px] text-lh-text-mute mb-1">
        {label}
      </dt>
      <dd
        className={cnm(
          'text-xl font-semibold',
          mono ? 'font-mono tabular-nums' : '',
          href ? 'text-lh-accent' : '',
        )}
      >
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
