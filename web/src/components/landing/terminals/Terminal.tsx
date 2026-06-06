import { cnm } from '@/utils/style'

interface TerminalProps {
  label: string
  children: React.ReactNode
  className?: string
}

export function Terminal({ label, children, className }: TerminalProps) {
  return (
    <div
      className={cnm(
        'w-full max-w-md rounded-2xl overflow-hidden',
        'bg-lh-bg-elev',
        'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_32px_rgb(0_0_0/0.06)]',
        'dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_8px_32px_rgb(0_0_0/0.3)]',
        className,
      )}
    >
      {/* Mac-style title bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-lh-line">
        <span className="w-2.5 h-2.5 rounded-full bg-lh-line-mid" />
        <span className="w-2.5 h-2.5 rounded-full bg-lh-line-mid" />
        <span className="w-2.5 h-2.5 rounded-full bg-lh-line-mid" />
        <span className="ml-3 font-mono text-[11px] text-lh-text-mute tracking-tight">
          {label}
        </span>
      </div>

      {/* Content area */}
      <div className="p-6 font-mono text-[13px] leading-[1.7] text-lh-text-dim min-h-[400px]">
        {children}
      </div>
    </div>
  )
}
