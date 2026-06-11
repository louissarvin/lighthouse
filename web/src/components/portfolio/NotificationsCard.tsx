import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { NotificationItem } from '@/lib/types'
import { Card } from '@/components/ui/Card'
import { EyebrowTag } from '@/components/ui/EyebrowTag'
import { apiFetch } from '@/lib/api'
import { cnm } from '@/utils/style'

interface NotificationsResponse {
  unreadCount: number
  notifications: Array<NotificationItem>
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const KIND_COLORS: Record<string, string> = {
  trade_settled: 'bg-emerald-400',
  deposit_swept: 'bg-blue-400',
  hedge_opened: 'bg-violet-400',
  hedge_settled: 'bg-emerald-400',
  budget_warning: 'bg-amber-400',
  agent_expired: 'bg-red-400',
  agent_revoked: 'bg-red-500',
  weekly_report_ready: 'bg-lh-accent',
}

export function NotificationsCard() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<NotificationsResponse>({
    queryKey: ['notifications', 'recent'],
    queryFn: () =>
      apiFetch<NotificationsResponse>('/notifications/recent?limit=20'),
    refetchInterval: 15_000,
    staleTime: 12_000,
  })

  const markReadMutation = useMutation({
    mutationFn: (id?: string) =>
      apiFetch('/notifications/mark-read', {
        method: 'POST',
        body: id ? { id } : {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const notifications = data?.notifications ?? []
  const unreadCount = data?.unreadCount ?? 0

  if (isLoading) return null

  if (notifications.length === 0) return null

  return (
    <Card className="p-6 md:p-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <EyebrowTag prefix="none">Notifications</EyebrowTag>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-lh-accent text-lh-bg text-[10px] font-bold px-1">
              {unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => markReadMutation.mutate(undefined)}
            disabled={markReadMutation.isPending}
            className="text-[11px] font-mono text-lh-text-mute hover:text-lh-text transition-colors"
          >
            Mark all read
          </button>
        )}
      </div>

      <ul className="space-y-1 divide-y divide-lh-line/50">
        {notifications.map((n) => {
          const isUnread = n.readAt === null
          const dotColor = KIND_COLORS[n.kind] ?? 'bg-lh-text-mute'
          return (
            <li
              key={n.id}
              className={cnm(
                'flex items-start gap-3 py-3 cursor-pointer group',
                isUnread && 'opacity-100',
                !isUnread && 'opacity-60',
              )}
              onClick={() => {
                if (isUnread) markReadMutation.mutate(n.id)
              }}
            >
              <span
                className={cnm(
                  'mt-1.5 w-2 h-2 rounded-full shrink-0 transition-opacity',
                  dotColor,
                  !isUnread && 'opacity-0',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-lh-text leading-snug group-hover:text-lh-accent transition-colors">
                  {n.title}
                </p>
                <p className="text-xs text-lh-text-dim leading-relaxed mt-0.5 line-clamp-2">
                  {n.body}
                </p>
              </div>
              <time className="shrink-0 font-mono text-[10px] text-lh-text-mute tabular-nums mt-0.5">
                {relativeTime(n.createdAt)}
              </time>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
