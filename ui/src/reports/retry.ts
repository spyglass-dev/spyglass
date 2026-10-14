/**
 * Retry for the query runner.
 *
 * A reporting backend under load answers 503, a proxy times out, a laptop
 * drops Wi-Fi for a second. Those are worth one or two more tries; a 400 or a
 * 500 from a bad query is not, because it will fail the same way again and the
 * user waits longer for the same error.
 */
import type { QueryResultLite, WidgetQuery } from '../querybuilder'

export interface RetryOptions {
  /** Extra attempts after the first. Default 2. */
  retries?: number
  /** Wait before the first retry, doubled each time. Default 500 ms. */
  delayMs?: number
  /** Override what counts as worth retrying. */
  isTransient?: (err: unknown) => boolean
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504])

/** A busy server, a timeout or a dropped connection: worth another try. */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status)
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /\b(408|429|502|503|504)\b|timed? ?out|timeout|network|failed to fetch|load failed|ECONNRESET|ECONNREFUSED|socket hang up|service unavailable|busy/i.test(
    msg,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wrap a query runner so transient failures are retried with backoff. */
export function withRetry(
  run: (query: WidgetQuery, opts?: { studentId?: string }) => Promise<QueryResultLite>,
  { retries = 2, delayMs = 500, isTransient = isTransientError }: RetryOptions = {},
): (query: WidgetQuery, opts?: { studentId?: string }) => Promise<QueryResultLite> {
  return async (query, opts) => {
    let attempt = 0
    for (;;) {
      try {
        return await run(query, opts)
      } catch (err) {
        if (attempt >= retries || !isTransient(err)) throw err
        await sleep(delayMs * 2 ** attempt)
        attempt += 1
      }
    }
  }
}
