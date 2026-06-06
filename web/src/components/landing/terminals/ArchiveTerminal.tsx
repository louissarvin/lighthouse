import { Terminal } from './Terminal'

export function ArchiveTerminal() {
  return (
    <Terminal label="~/lighthouse-coach">
      <div className="text-lh-text-dim mb-4">
        <span className="text-lh-text-mute">[Sunday 00:00 UTC]</span>
        {'  '}
        <span className="text-lh-text">weekly archive</span>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Aggregating week&apos;s decisions</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">14 recommendations</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">8 trades executed</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">6 anchored on chain</span>
        </div>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Building Quilt tearsheet</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">encrypted detail blob (SEAL)</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">public summary blob (Walrus)</span>
        </div>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Anchoring on Sui</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">AuditAnchor(kind=2, blob=0x...)</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">tx: 0xAv4L...p2</span>
        </div>
      </div>

      <div>
        <span className="text-lh-accent">✓</span>
        <span className="ml-2 text-lh-text">
          Tearsheet at walrus.app/blob/0x...
        </span>
      </div>

      <div className="mt-4">
        <span className="motion-safe:animate-pulse">▌</span>
      </div>
    </Terminal>
  )
}
