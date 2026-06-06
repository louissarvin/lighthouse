import { useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// Arrow 2 line length: Math.sqrt(0^2 + 36^2) = 36px
const ARROW2_LENGTH = 36

export default function ExecutorDiagram() {
  const svgRef = useRef<SVGSVGElement>(null)
  const arrowRef = useRef<SVGLineElement>(null)

  useGSAP(
    () => {
      const arrow = arrowRef.current
      if (!arrow) return

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          arrow,
          { attr: { strokeDashoffset: ARROW2_LENGTH } },
          {
            attr: { strokeDashoffset: 0 },
            duration: 0.55,
            ease: 'sui',
            scrollTrigger: {
              trigger: svgRef.current,
              start: 'top 75%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(arrow, { attr: { strokeDashoffset: 0 } })
      })
    },
    { scope: svgRef },
  )

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="auto"
      viewBox="0 0 360 480"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Capability-scoped agent wallet execution flow"
      role="img"
    >
      {/* USER box */}
      <rect
        x="120"
        y="24"
        width="120"
        height="48"
        rx="4"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
      />
      <text
        x="180"
        y="53"
        textAnchor="middle"
        fill="var(--color-lh-text)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        USER
      </text>

      {/* Arrow 1 */}
      <line
        x1="180"
        y1="72"
        x2="180"
        y2="108"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      <polygon
        points="175,104 180,112 185,104"
        fill="var(--color-lh-line-mid)"
      />

      {/* COACH box */}
      <rect
        x="100"
        y="112"
        width="160"
        height="56"
        rx="4"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
      />
      <text
        x="180"
        y="138"
        textAnchor="middle"
        fill="var(--color-lh-text)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        COACH
      </text>
      <text
        x="180"
        y="157"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        (proposes)
      </text>

      {/* Arrow 2 — amber draw-in on enter view */}
      <line
        ref={arrowRef}
        x1="180"
        y1="168"
        x2="180"
        y2="204"
        stroke="var(--color-lh-accent)"
        strokeWidth="1"
        strokeDasharray={ARROW2_LENGTH}
        strokeDashoffset={ARROW2_LENGTH}
      />
      <polygon points="175,200 180,208 185,200" fill="var(--color-lh-accent)" />

      {/* EXECUTOR AGENT box — lh-arch-executor applies the 6s stroke pulse */}
      <rect
        x="80"
        y="208"
        width="200"
        height="60"
        rx="4"
        className="lh-arch-executor"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-accent)"
        strokeWidth="1"
      />
      <text
        x="180"
        y="234"
        textAnchor="middle"
        fill="var(--color-lh-accent)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        EXECUTOR AGENT
      </text>
      <text
        x="180"
        y="253"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        budget-enforced
      </text>

      {/* Arrow 3 */}
      <line
        x1="180"
        y1="268"
        x2="180"
        y2="304"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      <polygon
        points="175,300 180,308 185,300"
        fill="var(--color-lh-line-mid)"
      />

      {/* DEEPBOOK POOL box */}
      <rect
        x="90"
        y="308"
        width="180"
        height="60"
        rx="4"
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-line-mid)"
        strokeWidth="1"
      />
      <text
        x="180"
        y="334"
        textAnchor="middle"
        fill="var(--color-lh-text)"
        fontSize="13"
        fontFamily="'JetBrains Mono', monospace"
        fontWeight="500"
      >
        DEEPBOOK POOL
      </text>
      <text
        x="180"
        y="353"
        textAnchor="middle"
        fill="var(--color-lh-text-dim)"
        fontSize="11"
        fontFamily="'JetBrains Mono', monospace"
      >
        whitelisted only
      </text>

      {/* Side annotations */}
      <text
        x="296"
        y="230"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
      >
        max 1000 USDC
      </text>
      <text
        x="296"
        y="244"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
      >
        / trade
      </text>

      <text
        x="296"
        y="270"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
      >
        10K USDC / day
      </text>

      <text
        x="296"
        y="310"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
      >
        revoke in 1 tx
      </text>

      {/* Bottom label */}
      <text
        x="180"
        y="420"
        textAnchor="middle"
        fill="var(--color-lh-text-mute)"
        fontSize="10"
        fontFamily="'JetBrains Mono', monospace"
        letterSpacing="0.12em"
      >
        CAPABILITY-SCOPED EXECUTION
      </text>
    </svg>
  )
}
