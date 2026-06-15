/**
 * Strip Telegram Markdown markers so question prompts render cleanly on web.
 * Removes *bold* wrappers and leading number-emoji prefixes like `1️⃣`.
 *
 * A keycap number like `1️⃣` is THREE codepoints: digit (`1`), variation
 * selector-16 (U+FE0F), and combining enclosing keycap (U+20E3). The previous
 * regex only consumed one of the combining marks, leaving the other orphaned
 * — which renders as an empty rectangle in fonts without that glyph.
 *
 * Also strips leading bullet characters (•, –, —) and stray combining marks
 * that may slip through.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, '$1') // *bold* → plain
    .replace(/^[\d#]+[️⃣]+\s*/u, '') // 1️⃣ / 2️⃣ / # keycap prefix
    .replace(/^[•–—]\s*/u, '') // leading •, –, — bullets
    .replace(/[️⃣]/gu, '') // any orphaned VS-16 / keycap survivors
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

/**
 * Very lightweight Telegram MarkdownV2 → plain text converter for display in
 * the web UI (e.g. coach message bubbles). Handles the most common escapes
 * without pulling in a full markdown parser.
 */
export function telegramMd2ToPlain(text: string): string {
  return text
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1') // unescape special chars
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')              // bold
    .replace(/__?([^_]+)__?/g, '$1')                  // italic/underline
    .replace(/~~([^~]+)~~/g, '$1')                    // strikethrough
    .replace(/`([^`]+)`/g, '$1')                      // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')          // links: [text](url) → text
    .trim()
}
