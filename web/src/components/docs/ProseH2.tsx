// Hash icon is not in the 13-icon allowlist in constants/icons.ts.
// Using a literal # glyph with aria-hidden instead — same visual intent,
// zero dependency surface, semantically correct for deep-link anchors.

interface ProseH2Props {
  id: string
  children: React.ReactNode
}

export function ProseH2({ id, children }: ProseH2Props) {
  return (
    <h2
      id={id}
      className="group relative text-[28px] font-semibold leading-[1.25] tracking-[-0.25px] text-lh-text mt-12 mb-4 scroll-mt-24"
    >
      <a
        href={`#${id}`}
        aria-label={`Link to ${typeof children === 'string' ? children : 'section'}`}
        className="absolute -left-6 top-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 text-lh-accent-warm font-mono text-[18px] leading-none select-none"
      >
        <span aria-hidden="true">#</span>
      </a>
      {children}
    </h2>
  )
}
