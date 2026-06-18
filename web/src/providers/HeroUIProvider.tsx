import { HeroUIProvider as Provider } from '@heroui/react'
import { useNavigate } from '@tanstack/react-router'

interface HeroUIProviderProps {
  children: React.ReactNode
}

/**
 * Wraps @heroui/react Provider with TanStack Router `navigate` so HeroUI's
 * internal Link components use the SPA router instead of doing full page
 * reloads. Per HeroUI docs: pass `navigate` and `useHref` to the provider.
 */
export default function HeroUIProvider({ children }: HeroUIProviderProps) {
  const navigate = useNavigate()
  return (
    <Provider navigate={(href: string) => void navigate({ to: href })}>
      {children}
    </Provider>
  )
}
