import { Terminal } from './Terminal'

export function ProfileTerminal() {
  return (
    <Terminal label="~/lighthouse-coach">
      <div className="text-lh-text-dim mb-4">
        <span className="text-lh-text-mute">[Lighthouse Coach]</span>
        {'  '}
        <span className="text-lh-text">/profile setup</span>
      </div>

      <div className="mb-4 space-y-1">
        <div className="text-lh-text-dim">Q1. Max position size in USDC?</div>
        <div>
          <span className="text-lh-text">&gt; 500</span>
        </div>
      </div>

      <div className="mb-4 space-y-1">
        <div className="text-lh-text-dim">Q2. Pools you trust?</div>
        <div>
          <span className="text-lh-text">&gt; SUI/USDC, WAL/USDC</span>
        </div>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Encrypting risk profile with SEAL</span>
        </div>
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Writing to Walrus</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">blob_id: 0x9f3a...c4d2</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">53 epochs</span>
        </div>
      </div>

      <div>
        <span className="text-lh-accent">✓</span>
        <span className="ml-2 text-lh-text">Profile sealed and persisted</span>
      </div>

      <div className="mt-4">
        <span className="motion-safe:animate-pulse">▌</span>
      </div>
    </Terminal>
  )
}
