import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { ColorWordReveal } from '@/components/elements/ColorWordReveal'

const THESIS =
  'Lighthouse stores every decision in verifiable memory so your trading edge outlives the app that built it. No coaching session lost to a closed tab. No position sized wrong because the AI forgot last month. Your alpha, anchored to Walrus, readable by any coach you authorize, auditable by anyone you choose.'

export default function ThesisParagraph() {
  return (
    <section
      aria-label="Mission statement"
      className="py-24 md:py-40 max-w-[1024px] mx-auto px-6"
    >
      <div className="mb-10">
        <EyebrowTag>The thesis</EyebrowTag>
      </div>
      <ColorWordReveal
        className="text-[30px] md:text-[40px] font-semibold leading-[1.2] tracking-[-0.5px]"
        pace="normal"
      >
        {THESIS}
      </ColorWordReveal>
    </section>
  )
}
