/**
 * AllTimeChip — the "unreachable scope" marker. Rendered by the widget frames
 * (ReportView / ReportCanvas) whenever a widget's resolved `applied.
 * dateRangeSkipped` says the report's active date range did not reach it.
 *
 * This is the visible half of `applyFilters` returning what it applied: a
 * widget the range can't touch shows beside widgets it can, and without the
 * marker the report presents them as one coherent time window — the silent
 * failure mode this library exists to prevent.
 */
import type { DateRangeSkipReason } from '../types'
import { tokens } from '../tokens'

const LABEL: Record<DateRangeSkipReason, string> = {
  no_time_field: 'All time',
  opted_out: 'All time',
  unknown_cube: 'All time',
  widget_pinned: 'Pinned range',
}

const DETAIL: Record<DateRangeSkipReason, string> = {
  no_time_field: "The report date range can't reach this widget — its cube declares no time field.",
  opted_out: 'This widget deliberately ignores the report date range.',
  unknown_cube: "The report filters can't identify this widget's cube.",
  widget_pinned: 'This widget pins its own date range; the report range does not apply.',
}

/** A widget that opts out on purpose (a running total) is information, not a
 *  warning: it reads as quiet text. Only a skip nobody asked for — no time
 *  field, an unknown cube, a pinned range — keeps the amber warning. On a
 *  dashboard of totals the amber pill on every tile was noise that hid the
 *  one that mattered. */
export function AllTimeChip({ reason }: { reason: DateRangeSkipReason }) {
  const deliberate = reason === 'opted_out'
  return (
    <span
      title={DETAIL[reason]}
      data-reason={reason}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
        fontSize: 11,
        fontWeight: 500,
        ...(deliberate
          ? { color: tokens.textFaint }
          : {
              padding: '1px 7px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.02em',
              color: tokens.warnText,
              background: tokens.warnBg,
              border: `1px solid ${tokens.warnBorder}`,
            }),
      }}
    >
      {deliberate && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )}
      {LABEL[reason]}
    </span>
  )
}
