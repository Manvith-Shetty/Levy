import { useEffect, useState } from 'react'

/** One short beat on first paint so skeletons are exercised, not faked forever. */
export function useBootDelay(ms = 280): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), ms)
    return () => clearTimeout(timer)
  }, [ms])
  return ready
}
