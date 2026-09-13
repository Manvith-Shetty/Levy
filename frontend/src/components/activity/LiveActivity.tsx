import { useLeash } from '../../lib/store'
import type { ActivityEvent } from '../../lib/types'
import { cx, formatTime } from '../../lib/utils'
import { describeShort, KIND_TONE } from './eventMeta'

export function LiveActivity({
  events,
  onSelect,
  limit = 10,
  columns = true,
}: {
  events: ActivityEvent[]
  onSelect: (event: ActivityEvent) => void
  limit?: number
  /** Two columns on wide screens; off for narrow cards. */
  columns?: boolean
}) {
  const { index } = useLeash()

  return (
    <ul className={cx(columns && 'gap-x-10 lg:columns-2')}>
      {events.slice(0, limit).map((event) => (
        <li key={event.id} className="break-inside-avoid">
          <button
            type="button"
            onClick={() => onSelect(event)}
            className="wash press flex w-full items-center gap-3 rounded-md px-2 py-2 text-left"
          >
            <span className="numeric w-10 shrink-0 text-[12px] text-faint">
              {formatTime(event.timestamp)}
            </span>
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', KIND_TONE[event.kind].dot)} />
            <span
              className={cx(
                'min-w-0 flex-1 truncate text-[13px]',
                event.kind === 'payment.blocked' ? 'text-blocked' : 'text-ink-dim',
              )}
            >
              {describeShort(event, index)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-authority">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ring absolute inset-0 rounded-full bg-authority" />
        <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-authority" />
      </span>
      LIVE
    </span>
  )
}
