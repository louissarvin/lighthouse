import { redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'

import type { ProfileMe } from '@/lib/types'
import { ApiError, apiFetch } from '@/lib/api'

type RouterContext = { queryClient: QueryClient }
type RouterLocation = { pathname: string; search?: Record<string, unknown> }

/**
 * TanStack Router `beforeLoad` helper.
 *
 * Forces an HTTP-level check of /profile/me. On 401/404 (no session cookie,
 * expired JWT, no bound profile) we redirect to /auth with `?next=` carrying
 * the originally-requested path so the user lands back where they started.
 *
 * We hit the backend instead of trusting the React context because the
 * router runs before React mounts. The result is also seeded into the query
 * cache so `useAuth()` is hot when the page mounts.
 */
export async function requireAuth({
  context,
  location,
}: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const qc = context.queryClient
  const key = ['auth', 'profile-me'] as const

  let profile: ProfileMe | null = null
  try {
    profile = await qc.fetchQuery({
      queryKey: key,
      queryFn: async () => {
        try {
          return await apiFetch<ProfileMe>('/profile/me')
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
            return null
          }
          throw e
        }
      },
      staleTime: 30_000,
    })
  } catch {
    profile = null
  }

  if (!profile) {
    const search = (location.search ?? {})
    const nextRaw =
      typeof search.next === 'string' && search.next.startsWith('/')
        ? search.next
        : location.pathname
    throw redirect({
      to: '/auth',
      search: { next: nextRaw } as never,
    })
  }
  return { profile }
}

/**
 * Like `requireAuth`, but also redirects to `/memwal-setup` when the user has
 * not yet bootstrapped their MemWal account.
 *
 * Use this on routes that need MemWal to be present (e.g. /setup, /coach).
 * Do NOT use on /memwal-setup itself — that would infinite-loop.
 */
export async function requireMemWal(args: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const result = await requireAuth(args)
  if (!result.profile.memwalAccountId) {
    const search = args.location.search ?? {}
    const nextRaw =
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : args.location.pathname
    throw redirect({
      to: '/memwal-setup',
      search: { next: nextRaw } as never,
    })
  }
  return result
}

/**
 * Like `requireAuth`, but also redirects to `/predict-setup` when the user
 * has not yet created their PredictManager.
 *
 * Chains through `requireMemWal` first — so the gate order is always:
 * auth → memwal → predict → destination.
 *
 * Do NOT use on /predict-setup itself — that would infinite-loop.
 */
export async function requirePredictManager(args: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const result = await requireMemWal(args)
  if (!result.profile.predictManagerId) {
    const search = args.location.search ?? {}
    const nextRaw =
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : args.location.pathname
    throw redirect({
      to: '/predict-setup',
      search: { next: nextRaw } as never,
    })
  }
  return result
}

/**
 * Like `requireAuth`, but also redirects to `/setup` when the user has not
 * completed the risk profile questionnaire.
 *
 * Chains through `requirePredictManager` first — so the gate order is always:
 * auth → memwal → predict → risk profile → destination.
 *
 * Use this on every protected route that requires risk setup (coach, predict,
 * trade). Do NOT use it on /setup, /memwal-setup, or /predict-setup — those
 * must be reachable before the respective step is finished.
 */
export async function requireRiskSetup(args: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const result = await requirePredictManager(args)
  if (!result.profile.riskProfileCompletedAt) {
    const search = args.location.search ?? {}
    const nextRaw =
      typeof search.next === 'string' &&
      search.next.startsWith('/') &&
      !search.next.startsWith('//')
        ? search.next
        : args.location.pathname
    throw redirect({
      to: '/setup',
      search: { next: nextRaw } as never,
    })
  }
  return result
}

/**
 * Like `requireAuth`, but also checks that the user's trading setup is
 * complete (BalanceManager + ExecutorAgent created). If not, redirects to
 * `/setup` with `?tab=trading`.
 *
 * Use on /trade and any route that exercises DeepBook flows.
 */
export async function requireTradingSetup(args: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const result = await requireRiskSetup(args)
  if (!result.profile.balanceManagerId || !result.profile.executorAgentId) {
    throw redirect({
      to: '/setup',
      search: { tab: 'trading', next: args.location.pathname } as never,
    })
  }
  return result
}
