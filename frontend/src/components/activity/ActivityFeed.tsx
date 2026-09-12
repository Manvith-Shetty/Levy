import { useLeash } from '../../lib/store'
import type { ActivityEvent } from '../../lib/types'
import { cx, money, shortHash, timeAgo, formatTime } from '../../lib/utils'
import { describe, KIND_LABEL, KIND_TONE } from './eventMeta'
import { EmptyState } from '../common/EmptyState'

export function ActivityFeed({
  events,
  onSelect,
  emptyBody = 'Agent payments and delegation events will appear here.',
}: {
  events: ActivityEvent[]
  onSelect: (event: ActivityEvent) => void
  emptyBody?: string
}) {
  const { index } = useLeash()

  if (events.length === 0) {
    return <EmptyState title="No activity yet" body={emptyBody} />
  }

  return (
    <ul className="divide-y divide-hairline">
      {events.map((event) => {
        const tone = KIND_TONE[event.kind]
        return (
          <li key={event.id}>
            <button
              type="button"
              onClick={() => onSelect(event)}
              className="wash press group flex w-full items-start gap-3.5 rounded-md px-2 py-3 text-left"
            >
              <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className={cx('text-[13px] font-medium', tone.text)}>
                    {KIND_LABEL[event.kind]}
                  </span>
                  <span className="text-[12.5px] text-muted">{describe(event, index)}</span>
                </div>
                {event.reason && event.kind === 'payment.blocked' && (
                  <p className="mt-1 text-[12.5px] text-faint">{event.reason}</p>
                )}
                {event.txId && (
                  <p className="mt-1 font-mono text-[11.5px] text-faint">
                    {shortHash(event.txId, 10, 6)}
                  </p>
                )}
              </div>

              <div className="shrink-0 text-right">
                {event.amount != null && (
                  <p
                    className={cx(
                      'numeric text-[13px] font-medium',
                      event.kind === 'payment.blocked' ? 'text-blocked line-through' : 'text-ink',
                    )}
                  >
                    {money(event.amount)}
                  </p>
                )}
                <p className="mt-0.5 text-[11.5px] text-faint" title={formatTime(event.timestamp)}>
                  {timeAgo(event.timestamp)}
                </p>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
