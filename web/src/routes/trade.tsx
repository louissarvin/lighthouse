import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useSearch } from '@tanstack/react-router'

import type { OrderIntent } from '@/components/trade/OrderForm'
import type {
  AgentSnapshotResponse,
  DeepBookPool,
  OrderBookSnapshot,
} from '@/lib/types'
import AppNav from '@/components/ui/AppNav'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { Skeleton } from '@/components/ui/Skeleton'
import { OrderBookPane } from '@/components/trade/OrderBookPane'
import { OrderForm } from '@/components/trade/OrderForm'
import { ConfirmModal } from '@/components/trade/ConfirmModal'
import { OnboardingBanner } from '@/components/ui/OnboardingBanner'
import { RecentTrades } from '@/components/trade/RecentTrades'
import { apiFetch } from '@/lib/api'
import { requireRiskSetup } from '@/lib/requireAuth'
import { useAuth } from '@/hooks/useAuth'

// Static fallback — used when the live /deepbook/pools call hasn't resolved yet.
// Keeps the page fully functional with zero API latency on mount.
const FALLBACK_REGISTRY: Record<
  string,
  { label: string; poolId: string; baseType: string; quoteType: string }
> = {
  SUI_DBUSDC: {
    label: 'SUI / DBUSDC',
    poolId:
      '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',
    baseType: '0x2::sui::SUI',
    quoteType:
      '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
  },
  DEEP_SUI: {
    label: 'DEEP / SUI',
    poolId:
      '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
    baseType:
      '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
    quoteType: '0x2::sui::SUI',
  },
  WAL_SUI: {
    label: 'WAL / SUI',
    poolId:
      '0x8c1c1b186c4fddab1ebd53e0895a36c1d1b3b9a77cd34e607bef49a38af0150a',
    baseType:
      '0x9ef7676a9f81937a52ae4b2af8d511a28a0b080477c0c2db40b0ab8882240d76::wal::WAL',
    quoteType: '0x2::sui::SUI',
  },
}

// Search-param shape — used for handoff from /coach (RecommendationCard).
// Validates types defensively; unknown values fall back to undefined and the
// page renders fresh defaults.
interface TradeSearch {
  pool?: string
  side?: 'bid' | 'ask'
  price?: string
  quantity?: string
  rec?: string
}

export const Route = createFileRoute('/trade')({
  beforeLoad: requireRiskSetup,
  validateSearch: (raw): TradeSearch => ({
    pool: typeof raw.pool === 'string' ? raw.pool : undefined,
    side: raw.side === 'bid' || raw.side === 'ask' ? raw.side : undefined,
    price: typeof raw.price === 'string' ? raw.price : undefined,
    quantity: typeof raw.quantity === 'string' ? raw.quantity : undefined,
    rec: typeof raw.rec === 'string' ? raw.rec : undefined,
  }),
  component: TradePage,
  head: () => ({
    meta: [
      { title: 'Trade · Lighthouse' },
      {
        name: 'description',
        content:
          'Spot DeepBook trading with sponsored gas and atomic audit anchors.',
      },
    ],
  }),
})

function TradePage() {
  const { profile, isLoading: authLoading } = useAuth()
  const search = useSearch({ from: '/trade' })
  const [poolKey, setPoolKey] = useState(search.pool ?? 'SUI_DBUSDC')

  const { data: livePools } = useQuery<Array<DeepBookPool>>({
    queryKey: ['deepbook', 'pools'],
    queryFn: () => apiFetch<Array<DeepBookPool>>('/deepbook/pools'),
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const activeRegistry = useMemo(() => {
    if (!livePools || livePools.length === 0) return FALLBACK_REGISTRY
    const r: Record<
      string,
      { label: string; poolId: string; baseType: string; quoteType: string }
    > = {}
    for (const p of livePools) {
      r[p.poolKey] = {
        label: `${p.base} / ${p.quote}`,
        poolId: p.poolId,
        baseType: p.baseType,
        quoteType: p.quoteType,
      }
    }
    return r
  }, [livePools])
  const [presetPrice, setPresetPrice] = useState<{
    price: string
    side: 'bid' | 'ask'
  } | null>(
    search.price && search.side
      ? { price: search.price, side: search.side }
      : null,
  )
  const [confirmIntent, setConfirmIntent] = useState<OrderIntent | null>(null)

  // Honor the /coach handoff exactly once — if the page later navigates
  // (pool picker, etc) we don't want the URL params to keep over-riding.
  useEffect(() => {
    if (search.pool && search.pool !== poolKey) setPoolKey(search.pool)
    if (search.price && search.side) {
      setPresetPrice({ price: search.price, side: search.side })
    }
  }, [search.pool, search.price, search.side, search.quantity])

  const { data: agent } = useQuery<AgentSnapshotResponse>({
    queryKey: ['agent', 'snapshot', profile?.suiAddress ?? ''],
    queryFn: () => apiFetch<AgentSnapshotResponse>('/agent/snapshot'),
    enabled: !!profile,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const { data: book } = useQuery<OrderBookSnapshot>({
    queryKey: ['deepbook', 'book', poolKey, 10],
    queryFn: () =>
      apiFetch<OrderBookSnapshot>(`/deepbook/book/${poolKey}?levels=10`),
    refetchInterval: 1500,
    staleTime: 1000,
  })

  const pool = useMemo(
    () => activeRegistry[poolKey] ?? FALLBACK_REGISTRY['SUI_DBUSDC'],
    [activeRegistry, poolKey],
  )

  return (
    <main className="bg-lh-bg text-lh-text min-h-screen">
      <AppNav />
      <section className="pt-28 pb-20">
        <Container>
          <div className="mb-8">
            <EyebrowTag dot className="mb-3">
              DeepBook v3 · Sponsored
            </EyebrowTag>
            <h1 className="text-3xl md:text-[44px] font-bold tracking-[-0.03em] mb-2">
              Trade
            </h1>
            <p className="text-lh-text-dim text-base max-w-xl">
              Place a limit order on DeepBook. Lighthouse signs with the
              executor agent under your on-chain budget; gas is sponsored. Every
              order ships with an audit anchor in the same PTB.
            </p>
          </div>

          <OnboardingBanner className="mb-6" />

          {/* Pool picker */}
          <div className="mb-6 flex flex-wrap items-center gap-2">
            {Object.entries(activeRegistry).map(([key, meta]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPoolKey(key)}
                className={
                  'rounded-full px-4 py-1.5 text-xs font-mono uppercase tracking-[0.12em] border transition-colors ' +
                  (key === poolKey
                    ? 'bg-lh-accent/10 border-lh-accent text-lh-accent'
                    : 'border-lh-line text-lh-text-mute hover:text-lh-text')
                }
              >
                {meta.label}
              </button>
            ))}
          </div>

          {authLoading || !profile ? (
            <TradeSkeleton />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
              <div className="space-y-6">
                <OrderBookPane
                  poolKey={poolKey}
                  levels={10}
                  onPickPrice={(price, side) => setPresetPrice({ price, side })}
                />
                <RecentTrades filterAddress={profile.suiAddress} />
              </div>

              <div className="space-y-6">
                {search.rec && (
                  <div className="rounded-2xl border border-lh-accent/40 bg-lh-accent/10 px-4 py-3 text-xs leading-relaxed">
                    <p className="font-mono uppercase tracking-[0.14em] text-lh-accent mb-1">
                      Coach handoff
                    </p>
                    <p className="text-lh-text-dim">
                      Pre-filled from recommendation{' '}
                      <a
                        href={`/receipt/${search.rec}`}
                        className="font-mono text-lh-text hover:text-lh-accent underline underline-offset-4"
                      >
                        {search.rec.slice(0, 10)}…
                      </a>
                      . Verify the proof, then confirm to execute.
                    </p>
                  </div>
                )}
                <OrderForm
                  profile={profile}
                  agent={agent ?? null}
                  book={book ?? null}
                  presetPrice={presetPrice}
                  coachIntent={
                    search.price && search.side && search.quantity
                      ? {
                          price: search.price,
                          side: search.side,
                          quantity: search.quantity,
                        }
                      : null
                  }
                  onSubmit={setConfirmIntent}
                />
              </div>
            </div>
          )}
        </Container>
      </section>

      {profile && (
        <ConfirmModal
          open={!!confirmIntent}
          intent={confirmIntent}
          profile={profile}
          poolId={pool.poolId}
          baseType={pool.baseType}
          quoteType={pool.quoteType}
          onClose={() => setConfirmIntent(null)}
        />
      )}
    </main>
  )
}

function TradeSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
      <Skeleton className="h-[480px]" />
      <Skeleton className="h-[480px]" />
    </div>
  )
}
