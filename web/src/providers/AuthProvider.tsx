import { createContext, useCallback, useMemo, useState } from 'react'
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
  /**
   * True only while sign-out is in flight.
   * Use to show a loading spinner on the sign-out button.
   */
  isSigningOut: boolean
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
  /**
   * Side-effect to run during signOut, after the backend cookie is cleared
   * and before query cache invalidation. The bridge that wraps this provider
   * passes dapp-kit's `disconnectWallet()` here so the Enoki ephemeral key
   * is removed from IndexedDB on every sign-out — otherwise the signing key
   * persists across sign-outs and the next user on the same device could
   * sign transactions as the previous user.
   */
  onSignOutSideEffect?: () => Promise<void> | void
}

export function AuthProvider({
  children,
  enokiAddress = null,
  onSignOutSideEffect,
}: AuthProviderProps) {
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

  const [isSigningOut, setIsSigningOut] = useState(false)

  const refresh = useCallback(async (): Promise<ProfileMe | null> => {
    await qc.invalidateQueries({ queryKey: QUERY_KEY })
    return qc.getQueryData<ProfileMe | null>(QUERY_KEY) ?? null
  }, [qc])

  const signOut = useCallback(async () => {
    setIsSigningOut(true)
    try {
      await apiFetch('/auth/web/logout', { method: 'POST', body: {} })
    } catch {
      // tolerate — cookie may already be missing
    }
    // Disconnect Enoki wallet (clears the ephemeral signing key from
    // IndexedDB). Best-effort: if the bridge didn't pass this, we still
    // proceed with cookie clear + cache invalidation.
    if (onSignOutSideEffect) {
      try {
        await onSignOutSideEffect()
      } catch (e) {
        console.warn('[auth] enoki disconnect failed (cookie still cleared):', e)
      }
    }
    setIsSigningOut(false)
    qc.setQueryData(QUERY_KEY, null)
    await qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc, onSignOutSideEffect])

  const value: AuthContextValue = useMemo(
    () => ({
      profile: data ?? null,
      isLoading,
      isAuthed: !!data,
      enokiAddress,
      refresh,
      signOut,
      isSigningOut,
    }),
    [data, isLoading, enokiAddress, refresh, signOut, isSigningOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
