import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type {
  MemWalNamespacesResponse,
  MemWalRecallResponse,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { ApiError, apiFetch } from '@/lib/api'

/**
 * Interactive explorer for the 7 Lighthouse MemWal namespaces.
 *
 * - Lists every namespace with its human label + description (LIGHTHOUSE.md §7.1)
 * - Lets the user fire a semantic recall (limit=5) against ALL or one namespace
 * - Renders matches with distance + Walrus blob id + namespace tag
 *
 * The recall call goes through the auth-gated `/memwal/recall` route which
 * decrypts the user's MemWal delegate key server-side. The frontend never
 * touches the raw key.
 */
export function MemWalExplorer() {
  const { data: meta, isLoading: metaLoading } =
    useQuery<MemWalNamespacesResponse>({
      queryKey: ['memwal', 'namespaces'],
      queryFn: () => apiFetch<MemWalNamespacesResponse>('/memwal/namespaces'),
      staleTime: 5 * 60_000,
    })

  const [query, setQuery] = useState('')
  const [namespace, setNamespace] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{
    query: string
    namespace: string | null
  } | null>(null)

  const enabled = !!submitted && submitted.query.trim().length > 0
  const {
    data: recall,
    isLoading: recallLoading,
    error,
  } = useQuery<MemWalRecallResponse>({
    queryKey: ['memwal', 'recall', submitted?.query, submitted?.namespace],
    queryFn: () => {
      const qs = new URLSearchParams()
      qs.set('q', submitted!.query)
      if (submitted!.namespace) qs.set('namespace', submitted!.namespace)
      qs.set('limit', '5')
      return apiFetch<MemWalRecallResponse>(`/memwal/recall?${qs.toString()}`)
    },
    enabled,
    retry: false,
    staleTime: 60_000,
  })

  const filteredNamespaces = useMemo(() => meta?.namespaces ?? [], [meta])
  const memwalReady =
    !!meta?.memwalAccountId && meta.delegateConfigured === true

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim()) return
    setSubmitted({ query: query.trim(), namespace })
  }

  return (
    <Card className="p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            MemWal · Walrus-backed memory
          </p>
          <h2 className="text-2xl font-bold tracking-[-0.02em] mb-1">
            Memory namespaces
          </h2>
          <p className="text-sm text-lh-text-dim leading-relaxed max-w-xl">
            Seven canonical namespaces from LIGHTHOUSE.md §7.1. Recall is
            semantic — the coach grabs the top matches before every decision.
          </p>
        </div>
        {meta && (
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-lh-text-mute">
              Account
            </p>
            <p className="font-mono text-xs text-lh-text-dim mt-1 break-all max-w-[260px]">
              {meta.memwalAccountId ?? '—'}
            </p>
            <p
              className={cnm(
                'mt-1 inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.14em]',
                memwalReady ? 'text-emerald-300' : 'text-amber-300',
              )}
            >
              <span
                className={cnm(
                  'inline-block w-1.5 h-1.5 rounded-full',
                  memwalReady ? 'bg-emerald-400' : 'bg-amber-400',
                )}
                aria-hidden="true"
              />
              {memwalReady ? 'Delegate configured' : 'Awaiting delegate key'}
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setNamespace(null)}
            className={
              'rounded-full px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em] border transition-colors ' +
              (namespace === null
                ? 'bg-lh-accent/10 border-lh-accent text-lh-accent'
                : 'border-lh-line text-lh-text-mute hover:text-lh-text')
            }
          >
            All
          </button>
          {filteredNamespaces.map((n) => (
            <button
              key={n.namespace}
              type="button"
              onClick={() =>
                setNamespace((cur) =>
                  cur === n.namespace ? null : n.namespace,
                )
              }
              className={
                'rounded-full px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em] border transition-colors ' +
                (namespace === n.namespace
                  ? 'bg-lh-accent/10 border-lh-accent text-lh-accent'
                  : 'border-lh-line text-lh-text-mute hover:text-lh-text')
              }
            >
              {n.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Recall: e.g. SUI position, last lesson, copy-trader…"
            className="flex-1 rounded-xl border border-lh-line bg-lh-bg/60 px-4 py-2.5 text-sm focus:outline-none focus:border-lh-accent/60 focus:ring-1 focus:ring-lh-accent/40"
            disabled={!memwalReady}
          />
          <button
            type="submit"
            disabled={!memwalReady || !query.trim() || recallLoading}
            className={cnm(
              'inline-flex items-center gap-2 rounded-full',
              'bg-lh-accent text-lh-bg font-semibold',
              'text-sm px-5 py-2 leading-none',
              'hover:bg-lh-accent-warm transition-colors duration-150',
              'disabled:opacity-50 disabled:pointer-events-none',
            )}
          >
            {recallLoading ? '…' : 'Recall'}
          </button>
        </div>
      </form>

      {/* Namespace catalog (when no query submitted) */}
      {!submitted && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {metaLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <li
                  key={i}
                  className="h-16 rounded-xl border border-lh-line bg-lh-bg/40 animate-pulse"
                />
              ))
            : filteredNamespaces.map((n) => (
                <li
                  key={n.namespace}
                  className="rounded-xl border border-lh-line bg-lh-bg/40 px-4 py-3"
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute mb-1">
                    {n.namespace}
                  </p>
                  <p className="text-sm font-semibold text-lh-text mb-0.5">
                    {n.label}
                  </p>
                  <p className="text-xs text-lh-text-dim leading-snug">
                    {n.description}
                  </p>
                </li>
              ))}
        </ul>
      )}

      {/* Recall results */}
      {submitted && (
        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
            {recallLoading
              ? 'Recalling…'
              : `Top ${recall?.results.length ?? 0} for “${submitted.query}”${submitted.namespace ? ` · ${submitted.namespace}` : ' · all namespaces'}`}
          </p>
          {error && (
            <p className="text-sm text-red-300">
              {error instanceof ApiError
                ? `${error.message} (${error.code ?? error.status})`
                : (error).message}
            </p>
          )}
          {!recallLoading && recall?.results.length === 0 && (
            <p className="text-sm text-lh-text-dim">
              No matches. Try a different query, or place a trade first to
              populate this namespace.
            </p>
          )}
          {recall?.results.map((r, i) => (
            <div
              key={`${r.blobId}:${i}`}
              className="rounded-xl border border-lh-line bg-lh-bg/40 p-4"
            >
              <div className="flex items-center justify-between mb-2 gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute truncate">
                  {r.namespace ?? submitted.namespace ?? '—'}
                </span>
                <span className="font-mono text-[10px] text-lh-accent tabular-nums shrink-0">
                  d={r.distance.toFixed(3)}
                </span>
              </div>
              <p className="text-sm text-lh-text leading-snug mb-2 break-words">
                {r.text}
              </p>
              <p className="font-mono text-[10px] text-lh-text-mute truncate">
                blob {r.blobId.slice(0, 14)}…{r.blobId.slice(-8)}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
