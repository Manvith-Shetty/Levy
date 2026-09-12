import { cx } from '../../lib/utils'

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[]
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cx(
              'relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px]',
              selected
                ? 'border-authority text-ink'
                : 'border-transparent text-muted hover:text-ink-dim',
            )}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={cx(
                  'numeric rounded px-1 text-[11px]',
                  selected ? 'bg-authority/15 text-authority' : 'bg-raised text-faint',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
