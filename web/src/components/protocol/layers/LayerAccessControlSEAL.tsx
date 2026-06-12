import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { ArrowRight } from '@/constants/icons'

const CODE = `// Copy trader can ONLY read the risk-profile slice,
// for this profile, while grant is active.
entry fun seal_approve_copy_trader(
    id: vector<u8>,
    profile: &TraderProfile,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(check_id_prefix(&id, profile), EBadIdPrefix);
    let slice = extract_slice(&id);
    assert!(slice == b"risk-profile", EBadSlice);
    let granted_until = allowlist::granted_until(
        &profile.copy_trader_grants,
        &tx_context::sender(ctx),
    );
    assert!(
        granted_until > clock::timestamp_ms(clock),
        EExpired,
    );
}`

export function LayerAccessControlSEAL() {
  return (
    <section
      aria-labelledby="layer-seal-h2"
      className="py-16 md:py-24 border-t border-lh-line bg-lh-bg"
    >
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
              <EyebrowTag className="mb-4">02 / Access Control</EyebrowTag>
              <MaskReveal className="mb-6">
                <h2
                  id="layer-seal-h2"
                  className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text"
                >
                  You decide who reads your trading history. And you can change
                  your mind.
                </h2>
              </MaskReveal>
              <div className="space-y-4 text-base text-lh-text-dim leading-relaxed">
                <p>
                  Every memory blob Lighthouse writes is encrypted using SEAL,
                  MystenLabs' threshold identity-based encryption library. The
                  encryption key is not stored anywhere — it is mathematically
                  derived from the user's Sui object identity and a set of
                  independent key servers. No single server can decrypt without
                  a quorum.
                </p>
                <p>
                  SEAL supports three tiers of access. The owner reads
                  everything. A copy-trader gets a time-bounded grant to the{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    risk-profile
                  </code>{' '}
                  slice only — no trade history, no lesson log. An auditor gets
                  a temporary{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    AuditCap
                  </code>{' '}
                  NFT that grants full read access until the cap expires. Revoke
                  the cap in a single Move transaction and future decrypt
                  requests are denied immediately.
                </p>
                <p>
                  One SEAL gotcha to be honest about: past-decryption is not
                  retractable. If a copy-trader successfully called{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    fetchKeys
                  </code>{' '}
                  before you revoked their grant, they hold the derived
                  decryption key forever. SEAL can block future key requests; it
                  cannot reach into someone's memory and erase what they already
                  fetched. Lighthouse documents this in the copy-trader grant
                  flow and recommends short grant windows (30 days) and slice
                  rotation on revocation.
                </p>
              </div>
              <a
                href="/docs/seal-policies"
                className="mt-8 inline-flex items-center gap-2 text-sm text-lh-accent-warm font-mono uppercase tracking-[0.12em] hover:gap-3 transition-all duration-150"
              >
                SEAL policies in docs
                <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
              </a>
            </div>

            {/* Right: code panel */}
            <div className="bg-lh-bg-elev border border-lh-line rounded-2xl overflow-hidden">
              <div className="border-b border-lh-line px-5 py-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-lh-text-mute language-move">
                  Move
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
