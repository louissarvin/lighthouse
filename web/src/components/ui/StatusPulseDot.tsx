interface StatusPulseDotProps {
  label: string
}

export function StatusPulseDot({ label }: StatusPulseDotProps) {
  return (
    <div className="inline-flex items-center gap-2">
      <span
        className="lh-pulse-dot relative inline-block w-2 h-2 rounded-full bg-lh-accent"
        aria-hidden="true"
      />
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
        {label}
      </span>
    </div>
  )
}
