/**
 * QueryBuilder — build a data widget from a cube query instead of dropping a
 * canned one: pick a cube, its measures/dimensions, and a visualization, with a
 * live preview run against the host's engine. Edits a `WidgetDraft` (controlled)
 * and offers a raw-JSON config editor for power users. Tailwind design tokens.
 */
import { useEffect, useMemo, useState } from 'react'
import { Widget } from './Widget'
import {
  draftCube,
  draftToWidgetSpec,
  type CubeModelMeta,
  type QueryResultLite,
  type WidgetDraft,
} from '../querybuilder'
import type { WidgetSpec } from '../types'

const VIZ: { value: WidgetDraft['as']; label: string }[] = [
  { value: 'metric', label: 'Metric' },
  { value: 'table', label: 'Table' },
  { value: 'chart', label: 'Chart' },
  { value: 'pivot', label: 'Pivot' },
]
const MARKS: WidgetDraft['mark'][] = ['bar', 'line', 'area', 'point']

export function QueryBuilder({
  meta,
  value,
  onChange,
  runQuery,
}: {
  meta: CubeModelMeta
  value: WidgetDraft
  onChange: (next: WidgetDraft) => void
  runQuery: (query: WidgetQueryLike) => Promise<QueryResultLite>
}) {
  const cubes = meta.cubes ?? []
  const [cubeName, setCubeName] = useState<string>(() => draftCube(value) ?? cubes[0]?.name ?? '')
  const cube = useMemo(() => cubes.find((c) => c.name === cubeName) ?? cubes[0], [cubes, cubeName])
  const [showJson, setShowJson] = useState(false)

  const measures = value.query.measures ?? []
  const dimensions = value.query.dimensions ?? []

  const patchQuery = (patch: Partial<WidgetDraft['query']>) =>
    onChange({ ...value, query: { ...value.query, ...patch } })

  const pickCube = (name: string) => {
    setCubeName(name)
    onChange({ ...value, query: { measures: [], dimensions: [], filters: [] } })
  }
  const toggle = (list: string[], member: string) =>
    list.includes(member) ? list.filter((m) => m !== member) : [...list, member]

  // Live preview.
  const [preview, setPreview] = useState<WidgetSpec | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = JSON.stringify(value)
  useEffect(() => {
    if (!measures.length && !dimensions.length) {
      setPreview(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    runQuery(value.query)
      .then((r) => !cancelled && setPreview(draftToWidgetSpec(value, r)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!cube) return <div className="p-4 text-sm text-muted-foreground">No cubes available.</div>

  const nonTenantDims = cube.dimensions.filter((d) => !d.tenant)

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[260px_1fr]">
      {/* Left: pickers */}
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
        <Field label="Data source">
          <select
            value={cube.name}
            onChange={(e) => pickCube(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          >
            {cubes.map((c) => (
              <option key={c.name} value={c.name}>
                {c.title || c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Show as">
          <div className="flex gap-1">
            {VIZ.map((v) => (
              <Chip key={v.value} on={value.as === v.value} onClick={() => onChange({ ...value, as: v.value })}>
                {v.label}
              </Chip>
            ))}
          </div>
          {value.as === 'chart' && (
            <div className="mt-1.5 flex gap-1">
              {MARKS.map((m) => (
                <Chip key={m} on={(value.mark ?? 'bar') === m} onClick={() => onChange({ ...value, mark: m })}>
                  {m}
                </Chip>
              ))}
            </div>
          )}
          {value.as === 'pivot' && (
            <div className="mt-1 text-xs text-muted-foreground">
              First group-by → rows, second → columns, first measure → cells.
            </div>
          )}
        </Field>

        <Field label={`Measures${measures.length ? ` (${measures.length})` : ''}`}>
          <div className="flex flex-col gap-0.5">
            {cube.measures.map((m) => (
              <Check
                key={m.member}
                on={measures.includes(m.member)}
                onClick={() => patchQuery({ measures: toggle(measures, m.member) })}
              >
                {m.title || m.name}
              </Check>
            ))}
          </div>
        </Field>

        <Field label={`Group by${dimensions.length ? ` (${dimensions.length})` : ''}`}>
          <div className="flex flex-col gap-0.5">
            {nonTenantDims.map((d) => (
              <Check
                key={d.member}
                on={dimensions.includes(d.member)}
                onClick={() => patchQuery({ dimensions: toggle(dimensions, d.member) })}
              >
                {d.title || d.name}
              </Check>
            ))}
          </div>
        </Field>

        <Field label="Title">
          <input
            value={value.title ?? ''}
            onChange={(e) => onChange({ ...value, title: e.target.value || undefined })}
            placeholder="Optional widget title"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
        </Field>
      </div>

      {/* Right: preview */}
      <div className="min-w-0 rounded-xl border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {loading ? 'Running…' : 'Preview'}
          </span>
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showJson ? 'Hide config' : 'Edit config'}
          </button>
        </div>

        {showJson ? (
          <JsonConfig value={value} onChange={onChange} />
        ) : error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        ) : preview ? (
          <div className="rounded-lg bg-background p-3">
            {preview.title && preview.type !== 'metric' && (
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {preview.title}
              </div>
            )}
            <Widget spec={preview} />
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Pick a measure or dimension to preview.
          </div>
        )}
      </div>
    </div>
  )
}

type WidgetQueryLike = WidgetDraft['query']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
        on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:border-primary/50'
      }`}
    >
      {children}
    </button>
  )
}

function Check({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted ${
        on ? 'text-foreground' : 'text-muted-foreground'
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded border text-[10px] ${
          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
        }`}
      >
        {on ? '✓' : ''}
      </span>
      {children}
    </button>
  )
}

function JsonConfig({ value, onChange }: { value: WidgetDraft; onChange: (d: WidgetDraft) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value])
  const apply = () => {
    try {
      onChange(JSON.parse(text) as WidgetDraft)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Invalid JSON')
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={14}
        className="w-full rounded-lg border border-border bg-background p-2 font-mono text-xs outline-none focus:border-primary"
      />
      {err && <div className="text-xs text-rose-600">{err}</div>}
      <button
        type="button"
        onClick={apply}
        className="self-start rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
      >
        Apply config
      </button>
    </div>
  )
}
