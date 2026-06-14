import { createContext, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { ProfileMe } from '@/lib/types'
import { ApiError, apiFetch } from '@/lib/api'

export interface AuthContextValue {
  profile: ProfileMe | null
  isLoading: boolean
  isAuthed: boolean
  /**
   * Sui address from the connected Enoki wallet.
   * Null when SuiEnokiProvider is not mounted (SSR) or user has not connected.
   * In dev, a mismatch with profile.suiAddress is logged as a config warning.
   */
  enokiAddress: string | null
  /** Invalidates the profile cache and returns the freshly fetched value. */
  refresh: () => Promise<ProfileMe | null>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

const QUERY_KEY = ['auth', 'profile-me'] as const

async function fetchMe(): Promise<ProfileMe | null> {
  try {
    return await apiFetch<ProfileMe>('/profile/me')
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
      return null
    }
    throw e
  }
}

interface AuthProviderProps {
  children: React.ReactNode
  /** Injected by the parent tree when SuiEnokiProvider is mounted. */
  enokiAddress?: string | null
}

export function AuthProvider({ children, enokiAddress = null }: AuthProviderProps) {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<ProfileMe | null>({
    queryKey: QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
  })

  if (
    import.meta.env.DEV &&
    enokiAddress &&
    data?.suiAddress &&
    data.suiAddress !== enokiAddress
  ) {
    console.warn(
      `[auth] Address mismatch: profile.suiAddress=${data.suiAddress} enokiAddress=${enokiAddress}. Check VITE_ENOKI_PUBLIC_KEY / VITE_GOOGLE_CLIENT_ID match the backend config.`,
    )
  }

  const refresh = useCallback(async (): Promise<ProfileMe | null> => {
    await qc.invalidateQueries({ queryKey: QUERY_KEY })
    return qc.getQueryData<ProfileMe | null>(QUERY_KEY) ?? null
  }, [qc])

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/web/logout', { method: 'POST', body: {} })
    } catch {
      // tolerate — cookie may already be missing
    }
    qc.setQueryData(QUERY_KEY, null)
    await qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc])

  const value: AuthContextValue = useMemo(
    () => ({
      profile: data ?? null,
      isLoading,
      isAuthed: !!data,
      enokiAddress,
      refresh,
      signOut,
    }),
    [data, isLoading, enokiAddress, refresh, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
