import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { ArrowRight } from '@/constants/icons'
import { GridBackdrop } from '@/components/elements/GridBackdrop'

const CODE = `// Write a SEAL-encrypted blob for a trade decision
const { blobId } = await client.walrus.writeBlob({
  blob: sealEncryptedBytes,
  deletable: false,
  epochs: 53,          // testnet: 53 days. mainnet: ~2 years.
  signer: backendKeypair,
});

// Anchor the blob on-chain
await lighthouse.auditAnchor.record({
  kind: 1,             // 0=recommendation, 1=trade, 2=weekly-report
  walrusBlobId: blobId,
  suiTxDigest: txDigest,
});`

export function LayerStorageWalrus() {
  return (
    <section
      aria-labelledby="layer-storage-h2"
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
              <EyebrowTag className="mb-4">01 / Storage</EyebrowTag>
              <MaskReveal className="mb-6">
                <h2
                  id="layer-storage-h2"
                  className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text"
                >
                  Every trade leaves a trace that outlives this app.
                </h2>
              </MaskReveal>
              <div className="space-y-4 text-base text-lh-text-dim leading-relaxed">
                <p>
                  Lighthouse writes every coaching decision and trade outcome to
                  Walrus as an erasure-coded blob. The data is split across
                  storage nodes using a scheme where the loss of any minority of
                  nodes still allows full reconstruction. A blob certified by
                  the on-chain BlobCertified event is permanent — no Lighthouse
                  backend can delete it.
                </p>
                <p>
                  On testnet, each blob has a 53-epoch lifespan (roughly 53
                  days). On mainnet, those same 53 epochs extend to over two
                  years. The epoch count is set at write time and cannot be
                  shortened. Your history compounds.
                </p>
                <p>
                  Each trade also gets an on-chain anchor in the{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    lighthouse::audit_anchor
                  </code>{' '}
                  Move module. The anchor records the Walrus blob ID plus the
                  Sui transaction digest so the link between on-chain execution
                  and off-chain memory is cryptographically verifiable.
                </p>
              </div>
              <a
                href="/docs/walrus-integration"
                className="mt-8 inline-flex items-center gap-2 text-sm text-lh-accent-warm font-mono uppercase tracking-[0.12em] hover:gap-3 transition-all duration-150"
              >
                Walrus integration guide
                <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
              </a>
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
