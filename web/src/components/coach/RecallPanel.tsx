import type { MemWalRecallEntry } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'

interface Props {
  // / Recalled memories from the last coach recommendation, OR a fresh
  // / `GET /memwal/recall` call. Sort order is honored.
  memories: Array<MemWalRecallEntry>
  loading?: boolean
  // / Optional headline override. Defaults to "Recalled from your memory".
  title?: string
  // / Optional subtitle. Defaults to the MemWal/Walrus pitch.
  subtitle?: string
}

/**
 * Visualises the MemWal cross-session recall layer.
 *
 * Demo-critical: this is the panel that proves "memory outlives the
 * session". When the coach references a past decision, the matching
 * blob shows up here with a distance score and a Walrus aggregator link.
 */
export function RecallPanel({ memories, loading, title, subtitle }: Props) {
  return (
    <Card className="p-6 h-full">
      <div className="mb-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-1">
          MemWal · Walrus
        </p>
        <h3 className="text-lg font-semibold tracking-[-0.01em] mb-1">
          {title ?? 'Recalled from your memory'}
        </h3>
        <p className="text-xs text-lh-text-dim leading-relaxed">
          {subtitle ??
            'Encrypted blobs the coach pulled from your Walrus-backed MemWal namespaces. Persists across sessions and devices.'}
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : memories.length === 0 ? (
        <div className="text-sm text-lh-text-dim leading-relaxed">
          <p className="mb-2">No matching memories yet.</p>
          <p className="text-xs text-lh-text-mute">
            Make a recommendation or place a trade. The coach writes a memory on
            every loop — encrypted, then queryable here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {memories.map((m, i) => (
            <li
              key={`${m.blobId}:${i}`}
              className="rounded-xl border border-lh-line bg-lh-bg/40 p-3"
            >
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute truncate">
                  {m.namespace ?? 'lighthouse:trades'}
                </span>
                <span className="font-mono text-[10px] text-lh-accent tabular-nums shrink-0">
                  {Number.isFinite(m.distance)
                    ? `d=${m.distance.toFixed(3)}`
                    : ''}
                </span>
              </div>
              <p className="text-sm text-lh-text leading-snug mb-2 break-words">
                {m.text}
              </p>
              <p className="font-mono text-[10px] text-lh-text-mute truncate">
                blob {m.blobId.slice(0, 12)}…{m.blobId.slice(-6)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
