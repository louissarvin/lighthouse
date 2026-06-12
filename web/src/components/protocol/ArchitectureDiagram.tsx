import { useReducedMotion } from 'motion/react'
import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'

// Consistent rectangle radius across all layer boxes
const BOX_RX = 8

interface ArchLayerProps {
  n: 1 | 2 | 3 | 4 | 5
  y: number
  layerLabel: string
  tech: string
  desc: string
  reduced: boolean
  isUser?: boolean
}

function ArchLayer({
  n,
  y,
  layerLabel,
  tech,
  desc,
  reduced,
  isUser,
}: ArchLayerProps) {
  const BOX_H = 72
  const BOX_W = 680
  const BOX_X = 20

  if (isUser) {
    return (
      <g>
        <rect
          x={BOX_X}
          y={y}
          width={BOX_W}
          height={BOX_H}
          rx={8}
          ry={8}
          fill="var(--color-lh-bg-elev)"
          stroke="var(--color-lh-line)"
          strokeWidth={1}
        />
        <text
          x={BOX_X + BOX_W / 2}
          y={y + BOX_H / 2 - 6}
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
          fontSize={11}
          fontWeight={500}
          fill="var(--color-lh-text-mute)"
          style={{ textTransform: 'uppercase', letterSpacing: '0.18em' }}
        >
          USER
        </text>
        <text
          x={BOX_X + BOX_W / 2}
          y={y + BOX_H / 2 + 14}
          textAnchor="middle"
          fontFamily="Inter Variable, Inter, sans-serif"
          fontSize={12}
          fill="var(--color-lh-text-dim)"
        >
          zkLogin / Google / Telegram
        </text>
      </g>
    )
  }

  const rectClass = reduced ? undefined : `lh-arch-layer-${n}`

  return (
    <g>
      {/* Connector arrow from above */}
      <line
        x1={BOX_X + BOX_W / 2}
        y1={y - 24}
        x2={BOX_X + BOX_W / 2}
        y2={y - 2}
        stroke="var(--color-lh-line)"
        strokeWidth={1}
        markerEnd="url(#arrowhead)"
      />
      <rect
        x={BOX_X}
        y={y}
        width={BOX_W}
        height={BOX_H}
        rx={BOX_RX}
        ry={BOX_RX}
        className={rectClass}
        fill="var(--color-lh-bg-elev)"
        stroke="var(--color-lh-line)"
        strokeWidth={1}
      />
      {/* Layer label left */}
      <text
        x={BOX_X + 20}
        y={y + BOX_H / 2 - 6}
        fontFamily="JetBrains Mono, monospace"
        fontSize={10}
        fontWeight={500}
        fill="var(--color-lh-text-mute)"
        style={{ textTransform: 'uppercase', letterSpacing: '0.14em' }}
      >
        {layerLabel}
      </text>
      {/* Description left */}
      <text
        x={BOX_X + 20}
        y={y + BOX_H / 2 + 14}
        fontFamily="Inter Variable, Inter, sans-serif"
        fontSize={12}
        fill="var(--color-lh-text-dim)"
      >
        {desc}
      </text>
      {/* Technology name right */}
      <text
        x={BOX_X + BOX_W - 20}
        y={y + BOX_H / 2 + 4}
        textAnchor="end"
        fontFamily="Inter Variable, Inter, sans-serif"
        fontSize={13}
        fontWeight={600}
        fill="var(--color-lh-text)"
      >
        {tech}
      </text>
    </g>
  )
}

const LAYERS: Array<{
  n: 1 | 2 | 3 | 4 | 5
  layerLabel: string
  tech: string
  desc: string
}> = [
  {
    n: 5,
    layerLabel: 'Layer 05 / Inference',
    tech: 'Atoma',
    desc: 'Llama-3.3-70B · decentralized · auditable',
  },
  {
    n: 4,
    layerLabel: 'Layer 04 / Execution',
    tech: 'DeepBook + Executor',
    desc: 'Capability wallet · budget-enforced · revocable',
  },
  {
    n: 3,
    layerLabel: 'Layer 03 / Memory',
    tech: 'MemWal',
    desc: '7 namespaces · cross-session · Walrus-backed',
  },
  {
    n: 2,
    layerLabel: 'Layer 02 / Access Control',
    tech: 'SEAL',
    desc: 'Threshold IBE · capability grants · revoke in 1 tx',
  },
  {
    n: 1,
    layerLabel: 'Layer 01 / Storage',
    tech: 'Walrus',
    desc: 'Erasure-coded · 53-epoch · immutable history',
  },
]

// viewBox height: user box 72 + gap 24 + 5 layer boxes (72*5) + 4 gaps (24*4) = 72 + 24 + 360 + 96 = 552
const VIEWBOX_H = 560
const BOX_H = 72
const GAP = 24

export function ArchitectureDiagram() {
  const reduced = useReducedMotion()

  // Compute y positions
  const userY = 0
  const layerYs = LAYERS.map((_, i) => userY + BOX_H + GAP + i * (BOX_H + GAP))

  return (
    <section
      aria-label="Architecture overview"
      className="py-24 md:py-32 bg-lh-bg"
    >
      <Container>
        <EyebrowTag dot className="mb-6">
          The stack
        </EyebrowTag>
        <MaskReveal className="mb-16">
          <h2 className="text-3xl md:text-[48px] font-bold leading-[1.1] tracking-[-1px] text-lh-text max-w-xl">
            Five primitives.{' '}
            <span className="text-lh-text-dim">One coherent system.</span>
          </h2>
        </MaskReveal>

        <div className="flex justify-center">
          <svg
            viewBox={`0 0 720 ${VIEWBOX_H}`}
            width="100%"
            style={{ maxWidth: '720px' }}
            aria-label="Lighthouse five-layer architecture diagram"
            role="img"
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth={8}
                markerHeight={6}
                refX={8}
                refY={3}
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="var(--color-lh-line)" />
              </marker>
            </defs>

            {/* User node */}
            <ArchLayer
              n={5}
              y={userY}
              layerLabel=""
              tech=""
              desc=""
              reduced={reduced ?? false}
              isUser
            />

            {/* Five protocol layers */}
            {LAYERS.map((layer, i) => (
              <ArchLayer
                key={layer.n}
                n={layer.n}
                y={layerYs[i]}
                layerLabel={layer.layerLabel}
                tech={layer.tech}
                desc={layer.desc}
                reduced={reduced ?? false}
              />
            ))}
          </svg>
        </div>
      </Container>
    </section>
  )
}
