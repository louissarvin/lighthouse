import { useEffect } from 'react'
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import {
  SuiClientProvider,
  WalletProvider,
  createNetworkConfig,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { isEnokiNetwork, registerEnokiWallets } from '@mysten/enoki'

const { networkConfig } = createNetworkConfig({
  testnet: {
    url: getJsonRpcFullnodeUrl('testnet'),
    network: 'testnet' as const,
  },
  mainnet: {
    url: getJsonRpcFullnodeUrl('mainnet'),
    network: 'mainnet' as const,
  },
})

const PUBLIC_KEY = import.meta.env.VITE_ENOKI_PUBLIC_KEY as string | undefined
const GOOGLE_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

/**
 * Registers Enoki wallets after the SuiClientProvider mounts.
 * Must be a child of SuiClientProvider so useSuiClientContext() is available.
 */
function EnokiRegister() {
  const { client, network } = useSuiClientContext()
  useEffect(() => {
    if (!PUBLIC_KEY || !GOOGLE_ID) {
      console.warn(
        '[enoki] VITE_ENOKI_PUBLIC_KEY or VITE_GOOGLE_CLIENT_ID missing — client signing disabled',
      )
      return
    }
    if (!isEnokiNetwork(network)) return
    const { unregister } = registerEnokiWallets({
      apiKey: PUBLIC_KEY,
      providers: {
        google: {
          clientId: GOOGLE_ID,
          redirectUrl: `${window.location.origin}/oauth-finish`,
        },
      },
      client,
      network,
    })
    return unregister
  }, [client, network])
  return null
}

export function SuiEnokiProvider({ children }: { children: React.ReactNode }) {
  return (
    <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
      <EnokiRegister />
      <WalletProvider autoConnect>{children}</WalletProvider>
    </SuiClientProvider>
  )
}
