import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import type { TearsheetListItem } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { ApiError, apiFetch } from '@/lib/api'
import { config } from '@/config'

interface RawTearsheetItem {
  week: string
  walrus_blob_id: string
  publicTearsheetUrl?: string
  auditAnchorTxDigest?: string | null
  total_trades?: number
  window_from?: string
  window_to?: string
  createdAt?: string
}

export function TearsheetList({ suiAddress }: { suiAddress: string }) {
  const { data, isLoading, isError } = useQuery<Array<RawTearsheetItem>>({
    queryKey: ['portfolio', 'tearsheets', suiAddress],
    queryFn: async () => {
      try {
        return await apiFetch<Array<RawTearsheetItem>>(
          `/tearsheet/list/${suiAddress}`,
        )
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return []
        throw e
      }
    },
    staleTime: 60_000,
  })

  const tearsheets: Array<TearsheetListItem> = (data ?? []).map((t) => ({
    week: t.week,
    walrus_blob_id: t.walrus_blob_id,
    publicTearsheetUrl: t.publicTearsheetUrl,
    auditAnchorTxDigest: t.auditAnchorTxDigest ?? undefined,
    total_trades: t.total_trades,
    window_from: t.window_from,
    window_to: t.window_to,
    createdAt: t.createdAt,
  }))

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-baseline justify-between mb-5">
        <h3 className="text-lg font-semibold">Weekly tearsheets</h3>
        <span className="font-mono text-[11px] text-lh-text-mute uppercase tracking-[0.12em]">
          Walrus Quilts
        </span>
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {isError && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          Tearsheet list unavailable
        </p>
      )}

      {!isLoading && !isError && tearsheets.length === 0 && (
        <p className="py-6 text-sm text-lh-text-dim text-center">
          No tearsheets yet. They are generated weekly on Sunday after at least
          one anchored trade.
        </p>
      )}

      {tearsheets.length > 0 && (
        <ul className="divide-y divide-lh-line">
          {tearsheets.map((t) => (
            <li key={t.week} className="flex items-center justify-between py-3">
              <div className="min-w-0">
                <p className="font-mono text-sm text-lh-text">{t.week}</p>
                <p className="text-xs text-lh-text-mute">
                  {t.total_trades !== undefined
                    ? `${t.total_trades} trades`
                    : 'Walrus Quilt'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {t.auditAnchorTxDigest && (
                  <a
                    href={`${config.links.explorerBase}/tx/${t.auditAnchorTxDigest}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-lh-text-mute hover:text-lh-accent transition-colors inline-flex items-center gap-1"
                  >
                    Anchor
                    <ExternalLink
                      size={11}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </a>
                )}
                {t.publicTearsheetUrl && (
                  <a
                    href={t.publicTearsheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-lh-accent hover:text-lh-accent-warm transition-colors inline-flex items-center gap-1"
                  >
                    Open
                    <ExternalLink
                      size={11}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
