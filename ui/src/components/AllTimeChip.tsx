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

export function AllTimeChip({ reason }: { reason: DateRangeSkipReason }) {
  return (
    <span
      title={DETAIL[reason]}
      data-reason={reason}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        color: tokens.warnText,
        background: tokens.warnBg,
        border: `1px solid ${tokens.warnBorder}`,
      }}
    >
      {LABEL[reason]}
    </span>
  )
}
