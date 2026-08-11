/**
 * DrillBreadcrumb — the drill trail above the canvas:
 * `All ▸ customer: Karl Seal ▸ status: paid`, each segment poppable.
 * This is drill-down's UNDO — its absence is why drill feels dangerous in
 * tools that lack it. Popping a segment truncates the trail there.
 */
import type { CSSProperties } from 'react'
import { drillStepLabel, type DrillTrail } from '../drill'
import { tokens } from '../tokens'

const crumb: CSSProperties = {
  border: `1px solid ${tokens.border}`,
  background: tokens.bg,
  color: tokens.text,
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

export function DrillBreadcrumb({
  trail,
  onPop,
}: {
  trail: DrillTrail
  /** Truncate the trail to its first `length` steps (0 = back to "All"). */
  onPop: (length: number) => void
}) {
  if (!trail.length) return null
  return (
    <nav
      aria-label="Drill trail"
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 0' }}
    >
      <button type="button" style={{ ...crumb, color: tokens.textMuted }} onClick={() => onPop(0)}>
        All
      </button>
      {trail.map((step, i) => {
        const last = i === trail.length - 1
        return (
          <span key={`${step.member}:${String(step.value)}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ color: tokens.textFaint, fontSize: 12 }}>
              ▸
            </span>
            <button
              type="button"
              style={{
                ...crumb,
                ...(last ? { background: tokens.accentSoft, borderColor: tokens.accent, cursor: 'default' } : {}),
              }}
              onClick={() => !last && onPop(i + 1)}
              title={last ? 'Current scope' : 'Back to this step'}
            >
              {drillStepLabel(step)}
              {!last && (
                <span aria-hidden style={{ marginLeft: 6, color: tokens.textFaint }}>
                  ↩
                </span>
              )}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
