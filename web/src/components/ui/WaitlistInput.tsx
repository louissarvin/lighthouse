import { useState } from 'react'
import { cnm } from '@/utils/style'

interface WaitlistInputProps {
  onSubmit: (email: string) => Promise<void>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function WaitlistInput({ onSubmit }: WaitlistInputProps) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!EMAIL_RE.test(email)) return
    setStatus('loading')
    try {
      await onSubmit(email)
      setStatus('done')
    } catch {
      setStatus('idle')
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 bg-lh-bg-elev border border-lh-line rounded-full p-1.5"
    >
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        required
        className={cnm(
          'flex-1 bg-transparent px-4 py-2 text-sm text-lh-text placeholder:text-lh-text-mute',
          'focus:outline-none',
        )}
      />
      <button
        type="submit"
        disabled={status !== 'idle'}
        className="lh-cta px-5 py-2 bg-lh-accent text-lh-bg text-sm font-semibold rounded-full disabled:opacity-60"
      >
        {status === 'done' ? 'Joined' : 'Join waitlist'}
      </button>
    </form>
  )
}
