import { Container } from '@/components/ui/Container'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { MaskReveal } from '@/components/elements/MaskReveal'
import AnimateComponent from '@/components/elements/AnimateComponent'
import { ArrowRight } from '@/constants/icons'

const CODE = `// Called by the backend agent to place a limit order.
// Aborts if: pool not whitelisted, budget exceeded,
// expired, or revoked.
public fun place_limit_under_budget<Base, Quote>(
    agent: &mut ExecutorAgent,
    bm: &mut BalanceManager,
    pool: &mut Pool<Base, Quote>,
    price: u64,
    quantity: u64,
    is_bid: bool,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo {
    assert!(!agent.revoked, ERevoked);
    assert!(now < agent.expires_at_ms, EExpired);
    assert!(pool_is_whitelisted(agent, pool), EPoolNotAllowed);
    assert!(notional <= agent.max_notional_per_trade, EBudgetExceeded);
    // ...
}`

export function LayerExecutionAgent() {
  return (
    <section
      aria-labelledby="layer-execution-h2"
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
              <EyebrowTag className="mb-4">04 / Execution</EyebrowTag>
              <MaskReveal className="mb-6">
                <h2
                  id="layer-execution-h2"
                  className="text-3xl md:text-[40px] font-bold leading-[1.1] tracking-[-0.5px] text-lh-text"
                >
                  The agent proposes. You confirm. The contract enforces the
                  limits.
                </h2>
              </MaskReveal>
              <div className="space-y-4 text-base text-lh-text-dim leading-relaxed">
                <p>
                  Lighthouse never holds your funds. When you onboard, you
                  create a{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    BalanceManager
                  </code>{' '}
                  on DeepBook and mint a{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    TradeCap
                  </code>{' '}
                  that delegates order placement rights to the Lighthouse{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    ExecutorAgent
                  </code>
                  . The agent runs with a locked budget: 1000 USDC maximum per
                  trade, 10,000 USDC per day, on whitelisted pools only, for a
                  fixed time window.
                </p>
                <p>
                  The budget is not advisory. It is enforced at the Move
                  contract level in{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    lighthouse::executor
                  </code>
                  . The{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    place_limit_under_budget
                  </code>{' '}
                  function checks pool whitelist, per-trade notional, rolling
                  24-hour notional, expiry, and revocation status in sequence.
                  Any check that fails aborts the transaction. The Lighthouse
                  backend cannot bypass these checks — the contract is the
                  authority.
                </p>
                <p>
                  Revocation is a single PTB:{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    executor::revoke
                  </code>{' '}
                  calls{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    balance_manager::revoke_trade_cap
                  </code>{' '}
                  in the same transaction. The agent's{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    trade_cap
                  </code>{' '}
                  is invalidated on-chain. Every subsequent order placement
                  attempt bounces with{' '}
                  <code className="font-mono text-[13px] text-lh-text">
                    ERevoked
                  </code>
                  . There is no grace period, no backend key to rotate, no
                  dependency on Lighthouse uptime.
                </p>
              </div>
              <a
                href="/docs/sdk-installation"
                className="mt-8 inline-flex items-center gap-2 text-sm text-lh-accent-warm font-mono uppercase tracking-[0.12em] hover:gap-3 transition-all duration-150"
              >
                SDK installation
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
