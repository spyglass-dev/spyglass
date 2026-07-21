/**
 * WidgetError — the widget error state. When a bound widget's query fails,
 * `resolveReport` emits a `{ type:'custom', component:'widget_error' }` spec
 * carrying a human message + raw detail; register this under `widget_error` and
 * it renders a compact card (headline, hint, collapsible detail) instead of raw
 * error text. Tailwind design tokens.
 */
import { useState } from 'react'
import { TriangleAlert, ChevronDown } from 'lucide-react'
import type { CustomWidgetProps } from '../registry'

export interface WidgetErrorData {
  message: string
  detail?: string
}

/** Map a raw engine error to a short, reader-friendly hint. */
export function humanizeWidgetError(detail: string): string {
  const d = detail.toLowerCase()
  if (d.includes('deserialize') || d.includes('invalid type') || d.includes('expected'))
    return "This widget's query was malformed — try rebuilding or removing it."
  if (d.includes('unauthorized') || d.includes('401') || d.includes('forbidden'))
    return "You don't have access to this data."
  if (d.includes('unknown') && (d.includes('cube') || d.includes('member') || d.includes('measure') || d.includes('dimension')))
    return 'This widget references data that no longer exists in the model.'
  if (d.includes('pool') || d.includes('unavailable') || d.includes('timeout') || d.includes('timed out') || d.includes('500') || d.includes('502') || d.includes('503'))
    return 'The reporting service is busy right now — refresh to retry.'
  if (d.includes('network') || d.includes('failed to fetch'))
    return 'Network problem reaching the reporting service — check your connection and refresh.'
  return "Couldn't load this widget's data."
}

export function WidgetError({ spec }: CustomWidgetProps) {
  const { message, detail } = (spec.data as WidgetErrorData | undefined) ?? { message: "Couldn't load this widget." }
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Couldn’t load this widget</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{message}</div>
          {detail && (
            <>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {open ? 'Hide details' : 'Details'}
                <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {detail}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
