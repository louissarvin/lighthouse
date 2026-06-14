/**
 * Strip Telegram Markdown markers so question prompts render cleanly on web.
 * Removes *bold* wrappers and leading number-emoji prefixes.
 * Keeps the full text (including "Examples:" sub-section) — callers that
 * want to split it apart use `splitPrompt`.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, '$1') // *bold* -> plain
    .replace(/^\d+[️⃣]?\s*/u, '') // strip leading number emoji prefix
    .trim()
}

/**
 * Splits a question prompt into its headline and optional examples sub-text.
 * The delimiter is the first blank line (`\n\n`) after stripping Markdown.
 *
 * Returns `{ headline, examples }` — `examples` is null when absent.
 */
export function splitPrompt(text: string): {
  headline: string
  examples: string | null
} {
  const clean = stripMarkdown(text)
  const idx = clean.indexOf('\n\n')
  if (idx === -1) return { headline: clean, examples: null }
  return {
    headline: clean.slice(0, idx).trim(),
    examples: clean.slice(idx + 2).trim() || null,
  }
}
