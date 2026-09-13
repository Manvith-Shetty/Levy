import { useId, useMemo, useState } from 'react'
import type { DayPoint } from '../../lib/selectors'
import { cx, formatDay, money } from '../../lib/utils'

/**
 * Daily settled spend. Drawn by hand rather than with a chart library so the
 * grid, the ticks and the hover read-out sit on the same type scale as the
 * rest of the console.
 */
export function SpendingChart({
  points,
  height = 220,
  compact = false,
}: {
  points: DayPoint[]
  height?: number
  compact?: boolean
}) {
  const gradientId = useId()
  const [hover, setHover] = useState<number | null>(null)

  const padLeft = compact ? 0 : 46
  const padRight = 4
  const padTop = 12
  const padBottom = compact ? 2 : 22
  const width = 720

  const { max, ticks } = useMemo(() => {
    // Scale to the data: live spend is fractions of a cent.
    const peak = Math.max(0, ...points.map((p) => p.total)) || 1
    const step = niceStep(peak / 3)
    const top = Math.ceil(peak / step) * step
    const count = Math.round(top / step)
    return { max: top, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) }
  }, [points])

  const innerW = width - padLeft - padRight
  const innerH = height - padTop - padBottom
  const x = (i: number) => padLeft + (innerW * i) / Math.max(1, points.length - 1)
  const y = (value: number) => padTop + innerH - (innerH * value) / max

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(p.total)}`).join(' ')
  const area = `${line} L${x(points.length - 1)} ${padTop + innerH} L${padLeft} ${padTop + innerH} Z`

  const active = hover != null ? points[hover] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - rect.left) / rect.width
          const px = ratio * width
          const i = Math.round(((px - padLeft) / innerW) * (points.length - 1))
          setHover(Math.min(points.length - 1, Math.max(0, i)))
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#35e0ae" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#35e0ae" stopOpacity="0" />
          </linearGradient>
        </defs>

        {!compact &&
          ticks.map((tick) => (
            <line
              key={tick}
              x1={padLeft}
              x2={width - padRight}
              y1={y(tick)}
              y2={y(tick)}
              stroke="#1a1d23"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke="#35e0ae"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active && (
          <>
            <line
              x1={x(hover!)}
              x2={x(hover!)}
              y1={padTop}
              y2={padTop + innerH}
              stroke="#2f333b"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(hover!)} cy={y(active.total)} r="3.5" fill="#08090b" stroke="#35e0ae" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {!compact && (
        <>
          <div
            className="pointer-events-none absolute top-0 left-0 flex flex-col justify-between text-[11px] text-faint"
            style={{ height: height - padBottom, paddingTop: padTop - 6 }}
          >
            {[...ticks].reverse().map((tick) => (
              <span key={tick} className="numeric">
                {money(tick >= 1 ? Math.round(tick) : tick)}
              </span>
            ))}
          </div>
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 flex justify-between pl-[6%] text-[11px] text-faint">
            {points.map((point, i) =>
              i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? (
                <span key={point.day} className="numeric">
                  {formatDay(point.date)}
                </span>
              ) : null,
            )}
          </div>
        </>
      )}

      {active && (
        <div
          className={cx(
            'pointer-events-none absolute top-2 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 shadow-[var(--shadow-floating)]',
          )}
          style={{
            left: `calc(${((x(hover!) - padLeft) / innerW) * 100}% - 10px)`,
            transform: hover! > points.length / 2 ? 'translateX(-100%)' : undefined,
          }}
        >
          <p className="numeric text-[13px] font-medium text-ink">{money(active.total)}</p>
          <p className="text-[11.5px] text-muted">{formatDay(active.date)}</p>
        </div>
      )}
    </div>
  )
}

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw > 0 ? raw : 1))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/** Tiny inline trend line for KPI tiles. */
export function Sparkline({ points, tone = '#35e0ae' }: { points: DayPoint[]; tone?: string }) {
  const max = Math.max(0, ...points.map((p) => p.total)) || 1
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, points.length - 1)) * 100} ${18 - (p.total / max) * 16}`)
    .join(' ')
  return (
    <svg viewBox="0 0 100 20" className="h-5 w-full" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}
