/**
 * Public web app configuration.
 *
 * Values read from `import.meta.env.VITE_*` are bundled at build time. For
 * local dev, copy to `.env.local`:
 *
 *   VITE_API_BASE_URL=http://localhost:3700
 *   VITE_TELEGRAM_BOT_URL=https://t.me/LighthouseCoachBot
 */

interface AppConfig {
  appName: string
  appDescription: string
  apiBaseUrl: string
  links: {
    twitter: string
    github: string
    telegram: string
    discord: string
    docs: string
    buy: string
    botUrl: string
    explorerBase: string
    walAppUrl: string
  }
  contracts: {
    main: string
    token: string
  }
  features: {
    darkMode: boolean
    smoothScroll: boolean
  }
  sui: {
    network: 'testnet' | 'mainnet'
    walrusSiteId?: string
  }
}

const apiBaseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:3700' : '')

const botUrl =
  (import.meta.env.VITE_TELEGRAM_BOT_URL as string | undefined) ??
  'https://t.me/LighthouseCoachBot'

export const config: AppConfig = {
  appName: 'Lighthouse',
  appDescription: 'AI trading coach with verifiable memory, on Sui + Walrus.',

  apiBaseUrl,

  links: {
    twitter: '',
    github: '',
    telegram: botUrl,
    discord: '',
    docs: '/docs',
    buy: '',
    botUrl,
    explorerBase: 'https://suiscan.xyz/testnet',
    walAppUrl: 'https://lighthouse.wal.app',
  },

  contracts: {
    main: '',
    token: '',
  },

  features: {
    darkMode: true,
    smoothScroll: true,
  },

  sui: {
    network: ((import.meta.env.VITE_SUI_NETWORK as string | undefined) ?? 'testnet') as 'testnet' | 'mainnet',
    walrusSiteId: import.meta.env.VITE_WALRUS_SITE_ID as string | undefined,
  },
}

export type Config = AppConfig

/**
 * Returns the Suiscan transaction explorer URL for a given digest.
 */
export function explorerTxUrl(digest: string): string {
  return `${config.links.explorerBase}/tx/${digest}`
}

/**
 * Returns the Suiscan object explorer URL for a given object ID.
 */
export function explorerObjectUrl(objectId: string): string {
  return `${config.links.explorerBase}/object/${objectId}`
}
