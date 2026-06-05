import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'

import { useCurrentAccount } from '@mysten/dapp-kit'

import HeroUIProvider from '../providers/HeroUIProvider'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import { ThemeProvider } from '../providers/ThemeProvider'
import { AuthProvider } from '../providers/AuthProvider'
import { SuiEnokiProvider } from '../providers/SuiEnokiProvider'
import ErrorPage from '../components/ErrorPage'
import { useIsClient } from '../hooks/useIsClient'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Lighthouse - AI trading coach with verifiable memory' },
      {
        name: 'description',
        content:
          'Lighthouse stores every decision in verifiable memory so your trading edge outlives the app that built it.',
      },
      {
        property: 'og:title',
        content: 'Lighthouse - AI trading coach with verifiable memory',
      },
      {
        property: 'og:description',
        content:
          'Lighthouse stores every decision in verifiable memory so your trading edge outlives the app that built it.',
      },
      { property: 'og:image', content: '/og.png' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/assets/logo-index.svg' },
      { rel: 'apple-touch-icon', href: '/assets/logo-index.svg' },
    ],
  }),

  shellComponent: RootDocument,
})

/**
 * Bridges the dapp-kit wallet account into AuthProvider.
 * Must be rendered inside SuiEnokiProvider (WalletProvider context).
 */
function AuthProviderWithEnoki({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount()
  return (
    <AuthProvider enokiAddress={account?.address ?? null}>
      {children}
    </AuthProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const isClient = useIsClient()
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?JSON.parse(s):'dark';if(t!=='light'&&t!=='dark')t='dark';var d=document.documentElement;d.classList.remove('light','dark');d.classList.add(t);d.style.colorScheme=t;}catch(e){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}})();`,
          }}
        />
      </head>
      <body className="bg-lh-bg text-lh-text">
        <ThemeProvider>
          <HeroUIProvider>
            {isClient ? (
              <SuiEnokiProvider>
                <AuthProviderWithEnoki>
                  <LenisSmoothScrollProvider />
                  {children}
                </AuthProviderWithEnoki>
              </SuiEnokiProvider>
            ) : (
              <AuthProvider>
                <LenisSmoothScrollProvider />
                {children}
              </AuthProvider>
            )}
          </HeroUIProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
