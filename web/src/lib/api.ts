/**
 * Lighthouse backend API client.
 *
 * - Reads base URL from `VITE_API_BASE_URL`. Falls back to `''` (same origin).
 * - Always `credentials: 'include'` so the httpOnly `lh_jwt` cookie travels.
 * - Normalizes the envelope `{success, error, data}` returned by Fastify routes
 *   into either `data` or a thrown `ApiError` so callers can rely on a single
 *   shape.
 *
 * The backend currently exposes the envelope on most routes. A few read-only
 * routes (`/activity/recent`, `/api/stats`) return the same envelope so this
 * client is safe everywhere.
 */

// Resolution order:
//   1. `VITE_API_BASE_URL` env (build-time bake).
//   2. In dev: `http://localhost:3700` (matches `bun run dev` in backend/).
//   3. Otherwise: `''` (same-origin — only works if backend is reverse-proxied
//      under the SPA domain).
const API_BASE_URL: string = (() => {
  const envUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
  if (envUrl) return envUrl.replace(/\/$/, '')
  if (import.meta.env.DEV) return 'http://localhost:3700'
  return ''
})()

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface Envelope<T> {
  success: boolean
  error: { code?: string; message?: string } | string | null
  data: T
  // / Optional fields used by some routes (e.g. /predict/markets).
  stale?: boolean
  source?: string
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  // / When true, GET requests skip the credentials include (used for fully
  // / public endpoints that don't need the cookie roundtrip). Defaults to false.
  noCredentials?: boolean
  // / Optional bearer token override (e.g. when receiving a one-shot JWT via
  // / query string before the cookie is set). Default reads from cookie.
  bearer?: string
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`
  const headers = new Headers(opts.headers ?? {})
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  let bodyInit: BodyInit | undefined
  if (opts.body !== undefined && opts.body !== null) {
    if (
      opts.body instanceof FormData ||
      opts.body instanceof Blob ||
      opts.body instanceof ArrayBuffer ||
      typeof opts.body === 'string'
    ) {
      bodyInit = opts.body as BodyInit
    } else {
      bodyInit = JSON.stringify(opts.body)
      if (!headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json')
    }
  }

  if (opts.bearer) headers.set('Authorization', `Bearer ${opts.bearer}`)

  let res: Response
  try {
    res = await fetch(url, {
      ...opts,
      headers,
      body: bodyInit,
      credentials: opts.noCredentials ? 'omit' : 'include',
    })
  } catch (e) {
    throw new ApiError((e as Error).message ?? 'network error', 0, 'NETWORK')
  }

  let parsed: unknown = null
  const text = await res.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    const env = parsed as Envelope<unknown> | null
    const err = env?.error
    const message =
      typeof err === 'string'
        ? err
        : (err?.message ?? `Request failed: ${res.status}`)
    const code = typeof err === 'object' && err ? err.code : undefined
    throw new ApiError(message, res.status, code)
  }

  // Envelope shape: { success, error, data }
  if (parsed && typeof parsed === 'object' && 'data' in (parsed)) {
    const env = parsed as Envelope<T>
    if (env.success === false) {
      const err = env.error
      const message =
        typeof err === 'string' ? err : (err?.message ?? 'Request failed')
      const code = typeof err === 'object' && err ? err.code : undefined
      throw new ApiError(message, res.status, code)
    }
    return env.data
  }

  return parsed as T
}

export function apiUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_BASE_URL}${path}`
}

// ────────────────────────────────────────────────────────────────────────
// Server-Sent Events client for `/coach/chat` (and any future SSE route).
//
// Why not use the native `EventSource`?
//   - `EventSource` cannot send a `Cookie` header on cross-origin requests
//     without setting `withCredentials: true`, AND many browsers still drop
//     the cookie under `SameSite=None`. The streamed Atoma response also
//     emits a custom `event: done` marker we want to surface to callers.
//   - `fetch` + ReadableStream is supported everywhere modern (incl. Safari
//     17+) and respects our existing `credentials: 'include'` model.
//
// Each `data:` line is JSON. The producer (`coachRoutes.ts`) emits
//   data: { "chunk": "..." }
// for each Atoma token, then `event: done` with empty body, or `event: error`
// with `{ "message": "..." }`.
// ────────────────────────────────────────────────────────────────────────

export interface SSEMessage {
  event: string
  data: string
}

export interface SSEStreamOptions {
  signal?: AbortSignal
  // / Optional bearer override (rarely useful — most calls ride the cookie).
  bearer?: string
}

/**
 * Stream Server-Sent Events from a path on the API. Yields each parsed
 * message in arrival order. The iterator completes when the server closes
 * the connection, the `signal` aborts, or a `done`/`error` event fires
 * (caller decides whether to break).
 */
export async function* sseStream(
  path: string,
  opts: SSEStreamOptions = {},
): AsyncGenerator<SSEMessage, void, unknown> {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (opts.bearer) headers.set('Authorization', `Bearer ${opts.bearer}`)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      signal: opts.signal,
    })
  } catch (e) {
    throw new ApiError((e as Error).message ?? 'network error', 0, 'NETWORK')
  }

  if (!res.ok || !res.body) {
    throw new ApiError(`SSE failed: ${res.status}`, res.status, 'SSE_HTTP')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE frames are separated by `\n\n`. A frame may have multiple
      // `event:` / `data:` lines; we flatten data lines with `\n`.
      let sepIdx: number
      while ((sepIdx = buf.indexOf('\n\n')) >= 0) {
        const rawFrame = buf.slice(0, sepIdx)
        buf = buf.slice(sepIdx + 2)
        let event = 'message'
        const dataLines: Array<string> = []
        for (const line of rawFrame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:'))
            dataLines.push(line.slice(5).trim())
        }
        yield { event, data: dataLines.join('\n') }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released — ignore.
    }
  }
}
