import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { GridBackdrop } from '@/components/elements/GridBackdrop'

const CODE = `const response = await atoma.chat.create({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  messages: [
    { role: "system", content: COACH_SYSTEM_PROMPT },
    { role: "user",   content: userPrompt },
  ],
  temperature: 0.3,
  maxCompletionTokens: 2000,
});

// Audit log stored with the Walrus blob
const attestation = {
  model: response.model,
  endpoint: "standard",
  request_hash: blake2b(promptBytes),
};`

export function LayerInferenceAtoma() {
  return (
    <section
      aria-labelledby="layer-atoma-h2"
      className="relative py-16 md:py-24 border-t border-lh-line bg-lh-bg"
    >
      <GridBackdrop opacity={0.03} />
      <Container>
        <AnimateComponent
          onScroll
          entry="fadeInUp"
          duration={550}
          threshold={0.15}
        >
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-12 lg:gap-20 items-start">
            {/* Left: text */}
            <div>
              <EyebrowTag className="mb-4">05 / Inference</EyebrowTag>
              <MaskReveal className="mb-6">
                <h2
                  id="layer-atoma-h2"
                  className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text"
                >
                  Decentralized inference. The coach's reasoning is
                  reproducible.
                </h2>
              </MaskReveal>
              <div className="space-y-4 text-base text-lh-text-dim leading-relaxed">
                <p>
                  Lighthouse routes all coaching inference through Atoma, a
                  decentralized AI network running on Sui. The v1 default model
                  is Llama-3.3-70B-Instruct. Atoma runs on a network of
                  independent nodes — the coach's recommendations are not routed
                  through a single OpenAI endpoint that Lighthouse (or anyone
                  else) controls exclusively. Decentralized inference is harder
                  to censor and harder to secretly modify.
                </p>
                <p>
                  Every recommendation blob stored on Walrus includes the Atoma
                  model name, the endpoint type (standard v1 for launch;
                  TEE-attested confidential for v2), and a BLAKE2b hash of the
                  prompt. The coach's reasoning is reproducible: given the same
                  prompt hash and model, the reasoning can be re-derived. The
                  audit trail is not just what the coach said — it is evidence
                  of how it was asked.
                </p>
              </div>
              <span className="mt-8 inline-flex items-center gap-2 text-sm text-lh-text-mute font-mono uppercase tracking-[0.12em]">
                Atoma docs (coming soon)
              </span>
            </div>

            {/* Right: code panel */}
            <div className="bg-lh-bg-elev border border-lh-line rounded-2xl overflow-hidden">
              <div className="border-b border-lh-line px-5 py-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute">
                  TypeScript
                </span>
              </div>
              <pre className="p-6 overflow-x-auto">
                <code className="font-mono text-[13px] leading-[1.6] text-lh-text-dim whitespace-pre">
                  {CODE}
                </code>
              </pre>
            </div>
          </div>
        </AnimateComponent>
      </Container>
    </section>
  )
}
