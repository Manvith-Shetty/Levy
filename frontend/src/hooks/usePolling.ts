import { useEffect, useRef, useState } from 'react'

interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

/** Calls `fetcher` immediately and then every `intervalMs`, until unmounted. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true })
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const data = await fetcherRef.current()
        if (!cancelled) setState({ data, error: null, loading: false })
      } catch (error) {
        if (!cancelled) {
          setState((prev) => ({
            data: prev.data,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }))
        }
      }
    }

    tick()
    const id = setInterval(tick, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return state
}
