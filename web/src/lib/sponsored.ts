import {
  useCurrentAccount,
  useSignTransaction,
  useSuiClientContext,
} from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'

import { ApiError, apiFetch } from '@/lib/api'

export type SponsorBuildResponse = { digest: string; bytes: string }
export type ExecuteResult = { digest: string }

type SuiChainId = `sui:${string}`

/**
 * Sign a sponsored transaction in-browser with the connected Enoki wallet's
 * zkLogin ephemeral key, then POST {digest, signature} to /sponsor/execute.
 *
 * The backend already built and sponsored the bytes via sponsorForAddress().
 * The wallet only signs — submission goes back through the backend which calls
 * enoki.executeSponsoredTransaction({ digest, signature }).
 *
 * Throws ApiError with code 'NO_ENOKI_WALLET' if the user has not connected
 * their Enoki wallet yet; callers should surface a toast directing the user to
 * sign in via /auth.
 *
 * Chain is read dynamically from the SuiClient context so mainnet promotion
 * needs only a single env change (VITE_SUI_NETWORK / defaultNetwork).
 */
export function useExecuteSponsored() {
  const { mutateAsync: signTransaction } = useSignTransaction()
  const account = useCurrentAccount()
  const { network } = useSuiClientContext()
  const chain: SuiChainId = `sui:${network}`

  return async (built: SponsorBuildResponse): Promise<ExecuteResult> => {
    if (!account) {
      throw new ApiError(
        'Enoki wallet not connected. Sign in with Google first.',
        401,
        'NO_ENOKI_WALLET',
      )
    }
    const tx = Transaction.from(fromBase64(built.bytes))
    const { signature } = await signTransaction({
      transaction: tx,
      account,
      chain,
    })
    return apiFetch<ExecuteResult>('/sponsor/execute', {
      method: 'POST',
      body: { digest: built.digest, signature },
    })
  }
}
