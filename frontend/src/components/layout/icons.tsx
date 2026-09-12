/** 16px stroke icons, drawn on the same 16-unit grid so the nav stays even. */
const props = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function IconOverview({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <rect x="2" y="2.5" width="5" height="5" rx="1" />
      <rect x="9" y="2.5" width="5" height="8.5" rx="1" />
      <rect x="2" y="10" width="5" height="3.5" rx="1" />
    </svg>
  )
}

export function IconAgents({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <circle cx="8" cy="3" r="1.6" />
      <circle cx="3.5" cy="12.5" r="1.6" />
      <circle cx="12.5" cy="12.5" r="1.6" />
      <path d="M8 4.6v2.6M3.5 10.9V8.2a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v2.7" />
    </svg>
  )
}

export function IconSpending({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M2 12.5 5.5 8l3 2.6L14 4" />
      <path d="M10.6 4H14v3.4" />
    </svg>
  )
}

export function IconActivity({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M2 8h2.6l1.7-4.4 3 9.4 1.9-5H14" />
    </svg>
  )
}

export function IconPolicies({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5V3.6Z" />
      <path d="M5.9 7.9 7.4 9.4l2.8-3" />
    </svg>
  )
}

export function IconServices({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <rect x="2" y="2.5" width="12" height="4" rx="1.2" />
      <rect x="2" y="9.5" width="12" height="4" rx="1.2" />
      <path d="M4.6 4.5h.01M4.6 11.5h.01" />
    </svg>
  )
}

export function IconSettings({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
    </svg>
  )
}

export function IconSearch({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="m10.6 10.6 3 3" />
    </svg>
  )
}

export function IconPlus({ className }: { className?: string }) {
  return (
    <svg {...props} strokeWidth={1.6} className={className} aria-hidden>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </svg>
  )
}

export function IconArrowLeft({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M12.5 8h-9M6.8 4.3 3.1 8l3.7 3.7" />
    </svg>
  )
}

export function IconExternal({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M9.4 2.6H13.4v4M13.4 2.6 7.6 8.4" />
      <path d="M12.4 9.9v2.8a1 1 0 0 1-1 1H3.3a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1h2.8" />
    </svg>
  )
}

export function IconDownload({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <path d="M8 2.6v7.2M5 7l3 3 3-3" />
      <path d="M2.8 12.2v.6a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-.6" />
    </svg>
  )
}

export function IconWallet({ className }: { className?: string }) {
  return (
    <svg {...props} className={className} aria-hidden>
      <rect x="2" y="3.8" width="12" height="8.6" rx="1.6" />
      <path d="M10.4 8.1h2.2" />
    </svg>
  )
}
