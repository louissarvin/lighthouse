export function WalrusBadge() {
  if (import.meta.env.VITE_HOSTED_ON_WALRUS !== 'true') return null

  return (
    <div className="inline-flex items-center gap-1.5">
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="1" y="1" width="10" height="5" rx="2" fill="#6800FF" />
        <rect
          x="2"
          y="7.5"
          width="8"
          height="3.5"
          rx="1.5"
          fill="#6800FF"
          opacity="0.55"
        />
      </svg>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
        Hosted on Walrus
      </span>
    </div>
  )
}
