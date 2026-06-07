import { useEffect, useState } from 'react'

/**
 * Returns true only after the component has mounted on the client.
 * Use to gate anything that touches browser-only APIs (localStorage,
 * IndexedDB, window) so SSR does not crash during hydration.
 */
export function useIsClient(): boolean {
  const [isClient, setIsClient] = useState(false)
  useEffect(() => {
    setIsClient(true)
  }, [])
  return isClient
}
