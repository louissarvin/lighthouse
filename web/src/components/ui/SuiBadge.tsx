export function SuiBadge() {
  return (
    <div className="inline-flex items-center gap-1.5">
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="6" cy="6" r="6" fill="#298DFF" />
      </svg>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
        Built on Sui
      </span>
    </div>
  )
}
