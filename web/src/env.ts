/**
 * Type-safe environment variables for the Lighthouse web app.
 *
 * All VITE_* vars must be declared here. Only listed vars are available to
 * runtime code — Vite bakes them at build time from .env.local or CI secrets.
 *
 * NEVER add sensitive values here (private keys, DB URLs). Those belong on
 * the backend. These are public-facing vars baked into the JS bundle.
 */

import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  server: {
    SERVER_URL: z.string().url().optional(),
  },

  /**
   * The prefix that client-side variables must have. This is enforced both at
   * a type-level and at runtime.
   */
  clientPrefix: 'VITE_',

  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
    // Enoki public API key (safe to expose — used client-side for zkLogin).
    VITE_ENOKI_PUBLIC_KEY: z.string().min(1).optional(),
    // Google OAuth client ID for Enoki zkLogin flow.
    VITE_GOOGLE_CLIENT_ID: z.string().optional(),
    // Backend API base URL (e.g. https://api.lighthouse.wal.app).
    VITE_API_BASE_URL: z.string().url().optional(),
    // Sui network (testnet | mainnet). Default: testnet.
    VITE_SUI_NETWORK: z.enum(['testnet', 'mainnet', 'devnet']).optional(),
  },

  /**
   * What object holds the environment variables at runtime. This is usually
   * `process.env` or `import.meta.env`.
   */
  runtimeEnv: import.meta.env,

  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
})
