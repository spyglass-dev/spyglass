/**
 * WidgetCard — the one frame every widget sits in: a title and the line that
 * says what it measures, the scope marker, an export menu, host actions, and
 * the widget. One frame is what makes a metric, a chart and a table read as
 * one report instead of three components that happen to be adjacent.
 *
 * Inline styles over the `--rpt-*` tokens, like the widgets: it renders the
 * same in a host with Tailwind and one without.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { WidgetSpec } from '../types'
import { tokens } from '../tokens'
import { AllTimeChip } from './AllTimeChip'
import { DEFAULT_WIDGET_EXPORTERS, type WidgetExportContext, type WidgetExporter } from '../exporters'

const card: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  boxSizing: 'border-box',
  background: tokens.bg,
  border: `1px solid ${tokens.border}`,
  borderRadius: 12,
  boxShadow: 'var(--rpt-card-shadow, 0 1px 2px rgba(16, 24, 40, 0.04))',
  overflow: 'hidden',
  minWidth: 0,
}

const iconBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: tokens.textMuted,
  cursor: 'pointer',
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function ExportMenu({ exporters, context }: { exporters: WidgetExporter[]; context: () => WidgetExportContext }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (!exporters.length) return null
  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button type="button" aria-label="Export" aria-haspopup="menu" aria-expanded={open} style={iconBtn} onClick={() => setOpen((o) => !o)}>
        <DownloadIcon />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 30,
            zIndex: 20,
            minWidth: 170,
            padding: 4,
            background: tokens.bg,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            boxShadow: '0 10px 30px -8px rgba(15, 23, 42, 0.25)',
          }}
        >
          {exporters.map((x) => (
            <button
              key={x.id}
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(x.id)
                try {
                  await x.run(context())
                } finally {
                  setBusy(null)
                  setOpen(false)
                }
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 13,
                border: 0,
                borderRadius: 6,
                background: 'transparent',
                color: tokens.text,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = tokens.muted)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {busy === x.id ? 'Preparing…' : x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface WidgetCardProps {
  spec: WidgetSpec
  children: ReactNode
  /** Host controls (edit, remove…) shown on hover. */
  actions?: ReactNode
  /** Exporters offered in the menu (default: CSV, PNG, JSON). `[]` hides it. */
  exporters?: WidgetExporter[]
  /** The full result for exports — see `WidgetExportContext.fetchAll`. */
  fetchAll?: () => Promise<WidgetSpec>
  /** Data is being re-fetched: keep showing it, dimmed, rather than blanking. */
  stale?: boolean
}

export function WidgetCard({ spec, children, actions, exporters = DEFAULT_WIDGET_EXPORTERS, fetchAll, stale }: WidgetCardProps) {
  const body = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const metric = spec.type === 'metric'
  // A note is a report's prose — a section heading, a teacher's summary — and
  // reads as text on the page, not as one more box.
  const prose = spec.type === 'note'
  const title = spec.title && !metric ? spec.title : undefined
  const skipped = spec.applied?.dateRangeSkipped
  const available = exporters.filter((x) => x.applies(spec))
  const context = (): WidgetExportContext => ({
    spec,
    title: spec.title ?? (spec.type === 'metric' ? spec.label ?? 'metric' : spec.type),
    element: body.current,
    fetchAll,
  })
  const controls = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, opacity: hover ? 1 : 0, transition: 'opacity 120ms' }}>
      <ExportMenu exporters={available} context={context} />
      {actions}
    </div>
  )
  if (prose) {
    return (
      <div
        style={{ position: 'relative', minWidth: 0, padding: '10px 2px 0' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <div style={{ position: 'absolute', top: 4, right: 0, zIndex: 2 }}>{controls}</div>
        {title && <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--rpt-text-strong, #111827)', marginBottom: 2 }}>{title}</div>}
        <div ref={body}>{children}</div>
      </div>
    )
  }
  return (
    <div
      style={{ ...card, padding: metric ? '14px 16px' : 16 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
    >
      {title || !metric ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, minHeight: 26 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && (
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--rpt-text-strong, #111827)', lineHeight: '20px' }}>{title}</div>
            )}
            {spec.description && !metric && (
              <div
                title={spec.description}
                style={{ fontSize: 12, color: tokens.textMuted, marginTop: 2, lineHeight: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {spec.description}
              </div>
            )}
          </div>
          {skipped && <AllTimeChip reason={skipped} />}
          {controls}
        </div>
      ) : (
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}>{controls}</div>
      )}
      <div ref={body} style={{ flex: 1, minWidth: 0, opacity: stale ? 0.55 : 1, transition: 'opacity 160ms' }}>
        {children}
      </div>
      {/* A metric's marker sits under the value, where a comparison would:
          in the corner it collided with any label longer than a word. */}
      {metric && !title && skipped && (
        <div style={{ marginTop: 6 }}>
          <AllTimeChip reason={skipped} />
        </div>
      )}
    </div>
  )
}
