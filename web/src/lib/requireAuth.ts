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
 * Like `requireAuth`, but also redirects to `/setup` when the user has not
 * completed the risk profile questionnaire.
 *
 * Use this on every protected route that requires risk setup (coach, predict,
 * trade). Do NOT use it on /setup itself or /portfolio — those must remain
 * reachable before the questionnaire is finished.
 */
export async function requireRiskSetup(args: {
  context: RouterContext
  location: RouterLocation
}): Promise<{ profile: ProfileMe }> {
  const result = await requireAuth(args)
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
