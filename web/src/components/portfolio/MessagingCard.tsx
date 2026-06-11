import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type {
  MessagingHealth,
  MessagingSendResponse,
  ProfileMe,
} from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { cnm } from '@/utils/style'
import { apiFetch } from '@/lib/api'
import { config } from '@/config'

interface Props {
  profile: ProfileMe
}

/**
 * Sui Stack Messaging — shows the two SEAL-encrypted notification groups
 * Coach maintains on behalf of every user:
 *
 *   - Coach Chat group (coach_group_uuid)
 *       Receives: trade_settled, hedge_*, budget_warning, agent_expired,
 *                  weekly_report_ready
 *   - Audit Log group (audit_group_uuid)
 *       Receives: agent_revoked, multi-agent grants/revokes
 *
 * NotificationDispatcher fans every notification across Telegram + this
 * encrypted messaging channel, so the message history is portable and
 * survives the coach backend going down (Walrus blob layer).
 */
export function MessagingCard({ profile }: Props) {
  const { data: health } = useQuery<MessagingHealth>({
    queryKey: ['messaging', 'health'],
    queryFn: () =>
      apiFetch<MessagingHealth>('/messaging/health', { noCredentials: true }),
    staleTime: 60_000,
  })

  return (
    <Card className="p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-lh-text-mute mb-2">
            Sui Stack Messaging · SEAL-encrypted
          </p>
          <h2 className="text-2xl font-bold tracking-[-0.02em] mb-1">
            Notifications
          </h2>
          <p className="text-sm text-lh-text-dim leading-relaxed max-w-xl">
            Coach posts every important event to two encrypted groups you own.
            Same message goes to your Telegram bot — pick whichever channel you
            prefer.
          </p>
        </div>
        <RelayerBadge health={health} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <GroupRow
          name="Coach Chat"
          uuid={profile.coachGroupUuid ?? null}
          categories={[
            'trade_settled',
            'hedge_opened',
            'hedge_settled',
            'budget_warning',
            'agent_expired',
            'weekly_report_ready',
          ]}
        />
        <GroupRow
          name="Audit Log"
          uuid={profile.auditGroupUuid ?? null}
          categories={['agent_revoked', 'multi-agent grants & revokes']}
        />
      </div>

      <MessageComposer
        profile={profile}
        relayerEnabled={health?.enabled === true}
      />

      <p className="mt-4 text-[11px] text-lh-text-mute leading-relaxed">
        Telegram DM is best-effort if you've started{' '}
        <a
          href={config.links.botUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-lh-accent hover:underline"
        >
          @LighthouseCoachBot
        </a>
        . Messaging groups always hold the canonical, encrypted record.
      </p>
    </Card>
  )
}

function MessageComposer({
  profile,
  relayerEnabled,
}: {
  profile: ProfileMe
  relayerEnabled: boolean
}) {
  const [target, setTarget] = useState<'coach' | 'audit'>('coach')
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [sentFeedback, setSentFeedback] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const MAX = 800
  const coachUuid = profile.coachGroupUuid ?? null
  const auditUuid = profile.auditGroupUuid ?? null
  const selectedUuid = target === 'coach' ? coachUuid : auditUuid
  const hasGroups = !!(coachUuid || auditUuid)

  async function send() {
    if (!selectedUuid || !text.trim() || pending) return
    setPending(true)
    setError(null)
    try {
      await apiFetch<MessagingSendResponse>('/messaging/send', {
        method: 'POST',
        body: { groupUuid: selectedUuid, text: text.trim() },
      })
      setText('')
      setSentFeedback(true)
      setTimeout(() => setSentFeedback(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (!hasGroups) {
    return (
      <p className="text-xs text-lh-text-mute border-t border-lh-line pt-4">
        Messaging not available — groups not provisioned yet.
      </p>
    )
  }

  return (
    <div className="border-t border-lh-line pt-5 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-lh-text-mute">
        Send Message
      </p>

      {/* Group selector */}
      <div className="flex gap-2">
        {coachUuid && (
          <button
            type="button"
            onClick={() => setTarget('coach')}
            className={cnm(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              target === 'coach'
                ? 'bg-lh-accent/10 text-lh-accent border border-lh-accent/30'
                : 'border border-lh-line text-lh-text-mute hover:text-lh-text',
            )}
          >
            Coach Chat
          </button>
        )}
        {auditUuid && (
          <button
            type="button"
            onClick={() => setTarget('audit')}
            className={cnm(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              target === 'audit'
                ? 'bg-lh-accent/10 text-lh-accent border border-lh-accent/30'
                : 'border border-lh-line text-lh-text-mute hover:text-lh-text',
            )}
          >
            Audit Log
          </button>
        )}
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          disabled={!relayerEnabled || pending}
          rows={3}
          placeholder={
            relayerEnabled
              ? 'Type a message…'
              : 'Relayer offline — messages unavailable'
          }
          className={cnm(
            'w-full rounded-xl border border-lh-line bg-lh-bg/60',
            'px-4 py-3 text-sm text-lh-text placeholder:text-lh-text-mute',
            'focus:outline-none focus:border-lh-accent transition-colors resize-none',
            (!relayerEnabled || pending) && 'opacity-50 cursor-not-allowed',
          )}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] text-lh-text-mute">
            {text.length} / {MAX}
          </span>
          <div className="flex items-center gap-2">
            {sentFeedback && (
              <span className="text-xs text-lh-accent font-semibold">Sent</span>
            )}
            <button
              type="button"
              onClick={send}
              disabled={
                !relayerEnabled || !text.trim() || pending || !selectedUuid
              }
              className={cnm(
                'rounded-full border border-lh-line px-4 py-1.5 text-xs font-semibold',
                'transition-colors',
                !relayerEnabled || !text.trim() || pending || !selectedUuid
                  ? 'opacity-40 cursor-not-allowed text-lh-text-mute'
                  : 'text-lh-text hover:border-lh-line-mid',
              )}
            >
              {pending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function RelayerBadge({ health }: { health?: MessagingHealth }) {
  const enabled = health?.enabled === true
  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1',
        'font-mono text-[10px] uppercase tracking-[0.14em]',
        enabled
          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
      )}
    >
      <span
        className={cnm(
          'inline-block w-1.5 h-1.5 rounded-full',
          enabled ? 'bg-emerald-400' : 'bg-amber-400',
        )}
        aria-hidden="true"
      />
      {enabled ? 'Relayer online' : 'Relayer offline'}
    </span>
  )
}

function GroupRow({
  name,
  uuid,
  categories,
}: {
  name: string
  uuid: string | null
  categories: Array<string>
}) {
  return (
    <div className="rounded-xl border border-lh-line bg-lh-bg/40 p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-sm font-semibold">{name}</p>
        <span
          className={cnm(
            'inline-block w-1.5 h-1.5 rounded-full',
            uuid ? 'bg-emerald-400' : 'bg-lh-text-mute',
          )}
          aria-hidden="true"
        />
      </div>
      <p className="font-mono text-[10px] text-lh-text-mute uppercase tracking-[0.14em] mb-1">
        Group UUID
      </p>
      <p className="font-mono text-xs text-lh-text-dim break-all mb-3">
        {uuid ?? 'not provisioned yet'}
      </p>
      <p className="font-mono text-[10px] text-lh-text-mute uppercase tracking-[0.14em] mb-1.5">
        Categories
      </p>
      <ul className="space-y-1 text-xs text-lh-text-dim">
        {categories.map((c) => (
          <li key={c} className="font-mono">
            · {c}
          </li>
        ))}
      </ul>
    </div>
  )
}
