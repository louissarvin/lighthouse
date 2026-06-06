import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// ── Types ─────────────────────────────────────────────────────────────────────

interface StatsResponse {
  success: boolean
  error: string | null
  data: {
    walrus_blobs_persisted: number | null
    decisions_logged: number | null
    walrus_epochs_active: number | null
    last_updated_ms: number
  }
}

const STAT_LABELS = [
  'Walrus blobs persisted',
  'Decisions logged',
  'Walrus epochs active',
] as const

// ── Component ─────────────────────────────────────────────────────────────────

export default function StatsStrip() {
  const sectionRef = useRef<HTMLElement>(null)
  const valueRefs = useRef<Array<HTMLSpanElement | null>>([])
  const cardRefs = useRef<Array<HTMLDivElement | null>>([])
  // Prevent the count-up from re-firing on background refetches
  const animatedRef = useRef(false)

  const { data, isError } = useQuery<StatsResponse>({
    queryKey: ['api-stats'],
    queryFn: async () => {
      const base = import.meta.env.VITE_API_BASE_URL ?? ''
      const res = await fetch(`${base}/api/stats`)
      if (!res.ok) throw new Error('Stats fetch failed')
      return res.json() as Promise<StatsResponse>
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
  })

  // Derive nullable values. null field or fetch error both render "--".
  const rawValues: Array<number | null> = data?.data
    ? [
        data.data.walrus_blobs_persisted,
        data.data.decisions_logged,
        data.data.walrus_epochs_active,
      ]
    : [null, null, null]

  const hasRealData =
    !isError && data != null && rawValues.some((v) => v !== null)

  // Sync "--" into the DOM when values are null or errored. Direct DOM write
  // stays consistent with the GSAP count-up onUpdate writes.
  useEffect(() => {
    rawValues.forEach((v, i) => {
      const el = valueRefs.current[i]
      if (!el) return
      if (v === null || isError) {
        el.textContent = '--'
      }
    })
  }) // deliberately no dependency array

  useGSAP(
    () => {
      const mm = gsap.matchMedia()

      // ── Per-stat stagger entrance ────────────────────────────────
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const cards = cardRefs.current.filter(Boolean)

        gsap.fromTo(
          cards,
          { y: 16, autoAlpha: 0 },
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.55,
            stagger: 0.08,
            ease: 'sui',
            scrollTrigger: {
              trigger: sectionRef.current,
              start: 'top 80%',
              once: true,
            },
          },
        )
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        cardRefs.current.forEach((el) => {
          if (el) gsap.set(el, { autoAlpha: 1, y: 0 })
        })
      })
    },
    { scope: sectionRef },
  )

  // GSAP count-up — fires once when real data arrives.
  useGSAP(
    () => {
      if (!hasRealData || animatedRef.current) return

      const mm = gsap.matchMedia()

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        rawValues.forEach((target, i) => {
          if (target === null) return
          const el = valueRefs.current[i]
          if (!el) return

          const obj = { val: 0 }
          gsap.to(obj, {
            val: target,
            duration: 1.2,
            ease: 'power3.out',
            snap: { val: 1 },
            onUpdate() {
              el.textContent = obj.val.toLocaleString('en-US')
            },
            scrollTrigger: {
              trigger: sectionRef.current,
              start: 'top 80%',
              once: true,
            },
          })
        })

        animatedRef.current = true
      })

      mm.add('(prefers-reduced-motion: reduce)', () => {
        rawValues.forEach((target, i) => {
          if (target === null) return
          const el = valueRefs.current[i]
          if (!el) return
          el.textContent = target.toLocaleString('en-US')
        })
        animatedRef.current = true
      })
    },
    { scope: sectionRef, dependencies: [hasRealData] },
  )

  return (
    <section
      ref={sectionRef}
      aria-label="Product statistics"
      className="border-y border-lh-line py-16 md:py-20"
    >
      <div className="max-w-6xl mx-auto px-6">
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-12 sm:gap-8">
          {STAT_LABELS.map((label, i) => {
            const isMiddle = i === 1

            return (
              <div
                key={label}
                ref={(el) => {
                  cardRefs.current[i] = el
                }}
                // Pre-render invisible for the stagger entrance
                className="flex flex-col items-center sm:items-start gap-3"
                style={{ opacity: 0 }}
              >
                <dt className="order-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute">
                  {label}
                </dt>

                {isMiddle ? (
                  // Middle stat: radial-gradient amber text-clip for editorial accent.
                  // Technique: sui.io Batch2 §Rank 7 adapted to amber.
                  // background-clip: text requires color: transparent.
                  <dd
                    className="order-1 font-bold leading-none tabular-nums"
                    style={{
                      fontSize: 'clamp(64px, 8vw, 96px)',
                      letterSpacing: '-3.5px',
                      lineHeight: '0.92',
                      backgroundImage:
                        'radial-gradient(circle at 50% 50%, #ffffff 0%, #ffffff 30%, #fbbf24 75%, rgba(251,191,36,0) 100%)',
                      WebkitBackgroundClip: 'text',
                      backgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      color: 'transparent',
                    }}
                  >
                    <span
                      ref={(el) => {
                        valueRefs.current[i] = el
                      }}
                      aria-live="polite"
                    >
                      --
                    </span>
                  </dd>
                ) : (
                  <dd
                    className="order-1 font-bold leading-none text-lh-accent tabular-nums"
                    style={{
                      fontSize: 'clamp(64px, 8vw, 96px)',
                      letterSpacing: '-3.5px',
                      lineHeight: '0.92',
                    }}
                  >
                    <span
                      ref={(el) => {
                        valueRefs.current[i] = el
                      }}
                      aria-live="polite"
                    >
                      --
                    </span>
                  </dd>
                )}
              </div>
            )
          })}
        </dl>
      </div>
    </section>
  )
}
