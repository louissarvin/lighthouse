import { useContext } from 'react'
import type { AuthContextValue } from '@/providers/AuthProvider'
import { AuthContext } from '@/providers/AuthProvider'

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error(
      'useAuth must be used inside <AuthProvider>. Did you forget to mount it in __root.tsx?',
    )
  }
  return ctx
}
