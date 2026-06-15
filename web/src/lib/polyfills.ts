/**
 * Browser polyfills required by Sui/zkLogin/Enoki SDKs.
 *
 * Import this file once at the app entry point (root route or main.ts) before
 * any @mysten/* imports. The SDKs rely on:
 *   - `Buffer` — used by @noble/hashes and @mysten/sui for byte ops.
 *   - `globalThis.process.env` — not needed (Vite bakes env at build time),
 *     but some older transitive deps call `process.env.NODE_ENV`. We leave
 *     this to Vite's `define` config in vite.config.ts.
 */
import { Buffer } from 'node:buffer'

if (typeof window !== 'undefined') {
  ;(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
  ;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}

export { Buffer }
