import { useEffect, useRef } from 'react'

export default function WalrusDiagram() {
  const NODES = [30, 78, 126, 174, 222, 270, 318]
  const svgRef = useRef<SVGSVGElement>(null)

  // IntersectionObserver: toggle data-visible on the SVG root.
  // CSS uses [data-visible='true'] to arm the node + line animations.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      ([entry]) => {
        svg.dataset.visible = entry.isIntersecting ? 'true' : 'false'
      },
      { threshold: 0, rootMargin: '0px' },
    )

    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="auto"
      viewBox="0 0 360 480"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Walrus persistence layer"
      role="img"
      data-visible="false"
    >
      {/* Label above nodes */}
      <text
        x="180"
        y="36"
        textAnchor="middle"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
        letterSpacing="0.12em"
      >
        STORAGE NODES
      </text>

      {/* Storage nodes row — each <g> carries --node-index for CSS stagger */}
      {NODES.map((cx, i) => (
        <g
          key={i}
          className="lh-walrus-node"
          style={{ '--node-index': i } as React.CSSProperties}
        >
          <circle
            cx={cx}
            cy="64"
            r="14"
            fill="var(--color-lh-bg-elev)"
            stroke="var(--color-lh-line-mid)"
            strokeWidth="1"
          />
          <text
            x={cx}
            y="69"
            textAnchor="middle"
            fill="var(--color-lh-text-dim)"
            fontSize="9"
            fontFamily="'JetBrains Mono', monospace"
          >
            N{i + 1}
          </text>
        </g>
      ))}

      {/* Erasure-coded lines from nodes down to blob — staggered dash-draw */}
      {NODES.map((cx, i) => (
        <line
          key={i}
          className="lh-walrus-line"
          style={{ '--node-index': i } as React.CSSProperties}
          x1={cx}
          y1="78"
          x2="180"
          y2="144"
          stroke="var(--color-lh-line)"
          strokeWidth="1"
          strokeDasharray="6 4"
          strokeDashoffset="60"
        />
      ))}

      {/* Erasure-code label */}
      <text
        x="180"
        y="122"
        textAnchor="middle"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
        letterSpacing="0.08em"
      >
        erasure-coded
      </text>

      {/* WALRUS BLOB capsule — lh-arch-blob-pulse for 6s stroke pulse */}
      <rect
        x="80"
        y="148"
        width="200"
        height="60"
        rx="30"
        className="lh-arch-blob-pulse"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-accent)"
        strokeWidth="1.5"
      />
      <text
        x="180"
        y="174"
        textAnchor="middle"
        fill="var(--color-lh-accent)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        WALRUS BLOB
      </text>
      <text
        x="180"
        y="193"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        53 epochs · immutable
      </text>

      {/* Arrow down from blob to sui anchor */}
      <line
        x1="180"
        y1="208"
        x2="180"
        y2="248"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
      />
      <polygon
        points="175,244 180,252 185,244"
        fill="var(--color-lh-line-mid)"
      />

      {/* SUI ANCHOR box */}
      <rect
        x="100"
        y="252"
        width="160"
        height="56"
        rx="4"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
      />
      <text
        x="180"
        y="278"
        textAnchor="middle"
        fill="var(--color-lh-text)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        SUI ANCHOR
      </text>
      <text
        x="180"
        y="297"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        on-chain proof
      </text>

      {/* Side annotation */}
      <line
        x1="10"
        y1="148"
        x2="10"
        y2="308"
        stroke="var(--color-lh-line)"
        strokeWidth="1"
      />
      <line
        x1="10"
        y1="148"
        x2="80"
        y2="148"
        stroke="var(--color-lh-line)"
        strokeWidth="1"
      />
      <line
        x1="10"
        y1="308"
        x2="100"
        y2="308"
        stroke="var(--color-lh-line)"
        strokeWidth="1"
      />

      <text
        x="180"
        y="378"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        Every trade. Every outcome.
      </text>
      <text
        x="180"
        y="396"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        Every rationale.
      </text>

      {/* Bottom label */}
      <text
        x="180"
        y="440"
        textAnchor="middle"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
        letterSpacing="0.12em"
      >
        WALRUS PERSISTENCE LAYER
      </text>
    </svg>
  )
}
