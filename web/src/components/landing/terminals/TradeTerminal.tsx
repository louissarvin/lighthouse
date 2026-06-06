import { Terminal } from './Terminal'

export function TradeTerminal() {
  return (
    <Terminal label="~/lighthouse-coach">
      <div className="text-lh-text-dim mb-4">
        <span className="text-lh-text-mute">[coach-agent]</span>
        {'  '}
        <span className="text-lh-text">recommend a trade</span>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Recalling from MemWal namespaces</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">risk-profile{'  '}(53d)</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">trade-history (last 7 days)</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">lessons (3 relevant)</span>
        </div>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Routing through Atoma</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">model: Llama-3.3-70B-Instruct</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">prompt hash: blake2b(0xc4d2...)</span>
        </div>
      </div>

      <div className="mb-4">
        <div>
          <span className="text-lh-text-dim">→</span>
          <span className="ml-2 text-lh-text">LONG SUI/USDC @ 4.20</span>
        </div>
        <div className="pl-5 text-lh-text-mute">
          notional: 200 USDC{'  '}(under 500 cap)
        </div>
      </div>

      <div className="mb-4">
        <span className="text-lh-text-dim">Confirm?{'  '}y/n</span>
        {'  '}
        <span className="text-lh-text">&gt;{'  '}y</span>
      </div>

      <div>
        <span className="text-lh-accent">✓</span>
        <span className="ml-2 text-lh-text">Trade placed on DeepBook v3</span>
      </div>
      <div className="pl-5 text-lh-text-mute">tx: 0xHKjB...vQ9</div>

      <div className="mt-4">
        <span className="motion-safe:animate-pulse">▌</span>
      </div>
    </Terminal>
  )
}
