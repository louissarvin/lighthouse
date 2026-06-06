import { Terminal } from './Terminal'

export function OnboardingTerminal() {
  return (
    <Terminal label="~/lighthouse-coach">
      <div className="text-lh-text-dim mb-4">
        <span className="text-lh-text-mute">[Lighthouse Coach]</span>
        {'  '}
        <span className="text-lh-text">/start</span>
      </div>

      <div className="space-y-0.5 mb-4">
        <div>
          <span className="text-lh-accent">●</span>
          <span className="ml-2">Welcome. Sign in with Google to begin.</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">zkLogin handshake initiated</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">Enoki sponsoring first transaction</span>
        </div>
      </div>

      <div className="space-y-0.5">
        <div>
          <span className="text-lh-accent">✓</span>
          <span className="ml-2 text-lh-text">Profile created</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">address: 0xa2b8...d872</span>
        </div>
        <div className="pl-4 text-lh-text-mute">
          <span>└─</span>
          <span className="ml-1">cost to you: 0 SUI</span>
        </div>
      </div>

      <div className="mt-4">
        <span className="motion-safe:animate-pulse">▌</span>
      </div>
    </Terminal>
  )
}
