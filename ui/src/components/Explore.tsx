/**
 * Explore — the workbench (spec §4.6). The property that makes it work:
 * the ask bar and the query chips edit ONE object (`WidgetDraft`). Text is
 * an editor of the same draft the chips edit — never a second authoring path
 * writing its own documents.
 *
 * Layout: ask bar on top; catalog rail (featured first, searchable) on the
 * left; the query as a chip sentence + auto-selected visualization in the
 * middle; the Explain panel (compiled SQL, row count, elapsed, validation)
 * on the right. Tailwind design tokens, like the rest of the framework layer.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Sparkles, Save, ChevronRight, X } from 'lucide-react'
import { Widget } from './Widget'
import { ReportLoading } from './ReportLoading'
import {
  autoViz,
  draftToWidgetSpec,
  emptyDraft,
  type CubeModelMeta,
  type QueryResultLite,
  type WidgetDraft,
  type WidgetQuery,
} from '../querybuilder'
import { validateQuery } from '../validate'
import type { WidgetSpec } from '../types'

export interface ExploreProps {
  meta: CubeModelMeta
  runQuery: (query: WidgetQuery) => Promise<QueryResultLite>
  /** Initial draft (e.g. a Question opened from a report). */
  initial?: WidgetDraft
  /** Save the current draft (into a report, or standalone). */
  onSave?: (draft: WidgetDraft) => void
  /** The host's agent: turn an ask into a draft — REPLACING the current one
   *  (same object the chips edit). Return null to leave the draft unchanged. */
  onAsk?: (prompt: string, current: WidgetDraft) => Promise<WidgetDraft | null>
}

const short = (member: string) => member.split('.').pop() ?? member

/** The query as a chip sentence: `Payments ▸ revenue ▸ by rating ▸ top 25`. */
function chips(draft: WidgetDraft): { key: string; text: string; remove?: (d: WidgetDraft) => WidgetDraft }[] {
  const q = draft.query
  const out: { key: string; text: string; remove?: (d: WidgetDraft) => WidgetDraft }[] = []
  for (const m of q.measures ?? [])
    out.push({
      key: `m:${m}`,
      text: short(m),
      remove: (d) => ({ ...d, query: { ...d.query, measures: (d.query.measures ?? []).filter((x) => x !== m) } }),
    })
  for (const dim of q.dimensions ?? [])
    out.push({
      key: `d:${dim}`,
      text: `by ${short(dim)}`,
      remove: (d) => ({ ...d, query: { ...d.query, dimensions: (d.query.dimensions ?? []).filter((x) => x !== dim) } }),
    })
  for (const t of q.timeDimensions ?? [])
    out.push({
      key: `t:${t.dimension}`,
      text: `${t.granularity ? `per ${t.granularity}` : 'in range'} (${short(t.dimension)})`,
      remove: (d) => ({
        ...d,
        query: { ...d.query, timeDimensions: (d.query.timeDimensions ?? []).filter((x) => x !== t) },
      }),
    })
  for (const f of q.filters ?? [])
    out.push({
      key: `f:${f.member}:${f.operator}`,
      text: `where ${short(f.member)} ${f.operator} ${(f.values ?? []).join(', ')}`,
      remove: (d) => ({ ...d, query: { ...d.query, filters: (d.query.filters ?? []).filter((x) => x !== f) } }),
    })
  if (q.limit !== undefined) out.push({ key: 'limit', text: `top ${q.limit}` })
  return out
}

export function Explore({ meta, runQuery, initial, onSave, onAsk }: ExploreProps) {
  const [draft, setDraft] = useState<WidgetDraft>(initial ?? emptyDraft())
  const [vizOverride, setVizOverride] = useState<WidgetDraft['as'] | null>(null)
  const [search, setSearch] = useState('')
  const [ask, setAsk] = useState('')
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<QueryResultLite | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [error, setError] = useState<{ message: string; suggestions?: string[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const runId = useRef(0)

  const hasSelection = (draft.query.measures?.length ?? 0) + (draft.query.dimensions?.length ?? 0) > 0
  const validation = useMemo(
    () => (hasSelection ? validateQuery(draft.query, meta) : null),
    [draft.query, meta, hasSelection],
  )

  // One effect runs the ONE query object — however it was edited.
  useEffect(() => {
    if (!hasSelection) {
      setResult(null)
      setError(null)
      return
    }
    if (validation && !validation.ok) {
      setError({ message: validation.error, suggestions: validation.suggestions })
      return
    }
    const id = ++runId.current
    setLoading(true)
    setError(null)
    const started = performance.now()
    runQuery(draft.query)
      .then((r) => {
        if (runId.current !== id) return
        setResult(r)
        setElapsed(Math.round(performance.now() - started))
      })
      .catch((e) => runId.current === id && setError({ message: e instanceof Error ? e.message : String(e) }))
      .finally(() => runId.current === id && setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draft.query)])

  const viz = vizOverride ?? autoViz(draft.query).as
  const effectiveDraft: WidgetDraft = {
    ...draft,
    as: viz,
    mark: draft.mark ?? autoViz(draft.query).mark,
  }
  const spec: WidgetSpec | null = result ? draftToWidgetSpec(effectiveDraft, result) : null

  const toggle = (list: string[] | undefined, member: string) =>
    (list ?? []).includes(member) ? (list ?? []).filter((m) => m !== member) : [...(list ?? []), member]
  const toggleMeasure = (m: string) =>
    setDraft((d) => ({ ...d, query: { ...d.query, measures: toggle(d.query.measures, m) } }))
  const toggleDimension = (m: string) =>
    setDraft((d) => ({ ...d, query: { ...d.query, dimensions: toggle(d.query.dimensions, m) } }))

  const submitAsk = async () => {
    const prompt = ask.trim()
    if (!prompt || !onAsk || asking) return
    setAsking(true)
    try {
      const next = await onAsk(prompt, draft)
      if (next) {
        setDraft(next)
        setVizOverride(null)
      }
    } finally {
      setAsking(false)
    }
  }

  const q = search.toLowerCase()
  const cubes = meta.cubes.map((cube) => ({
    ...cube,
    measures: [...cube.measures]
      .sort((a, b) => Number(b.featured ?? false) - Number(a.featured ?? false))
      .filter((m) => !q || m.member.toLowerCase().includes(q) || m.title?.toLowerCase().includes(q)),
    dimensions: [...cube.dimensions]
      .filter((d) => !d.tenant)
      .sort((a, b) => Number(b.featured ?? false) - Number(a.featured ?? false))
      .filter((d) => !q || d.member.toLowerCase().includes(q) || d.title?.toLowerCase().includes(q)),
  }))

  return (
    <div className="flex flex-col gap-3">
      {onAsk && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <Sparkles className={`h-4 w-4 shrink-0 ${asking ? 'animate-pulse text-primary' : 'text-muted-foreground'}`} />
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitAsk()}
            placeholder="Ask for data — the answer fills the same query the chips edit"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={submitAsk}
            disabled={asking || !ask.trim()}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr_260px]">
        {/* Catalog rail */}
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the catalog"
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          {cubes.map((cube) => (
            <div key={cube.name} className="flex flex-col gap-0.5">
              <div className="mt-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground" title={cube.description}>
                {cube.title ?? cube.name}
              </div>
              {cube.measures.map((m) => (
                <button
                  key={m.member}
                  type="button"
                  onClick={() => toggleMeasure(m.member)}
                  title={m.description}
                  className={`flex items-center justify-between rounded px-2 py-1 text-left text-xs ${
                    draft.query.measures?.includes(m.member)
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span>
                    {m.title ?? m.name}
                    {m.featured && <span className="ml-1 text-amber-500">★</span>}
                  </span>
                  {m.unit && <span className="text-[10px] text-muted-foreground">{m.unit}</span>}
                </button>
              ))}
              {cube.dimensions.map((d) => (
                <button
                  key={d.member}
                  type="button"
                  onClick={() => toggleDimension(d.member)}
                  title={d.description}
                  className={`flex items-center justify-between rounded px-2 py-1 text-left text-xs ${
                    draft.query.dimensions?.includes(d.member)
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <span>
                    by {d.title ?? d.name}
                    {d.featured && <span className="ml-1 text-amber-500">★</span>}
                  </span>
                  {d.type === 'time' && <span className="text-[10px] text-muted-foreground">time</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Canvas: chips + viz switcher + result */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Query chips">
            {chips(draft).map((c, i) => (
              <span key={c.key} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/60" aria-hidden />}
                <span className="flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground">
                  {c.text}
                  {c.remove && (
                    <button
                      type="button"
                      aria-label={`Remove ${c.text}`}
                      onClick={() => {
                        setDraft(c.remove!(draft))
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </span>
            ))}
            {!chips(draft).length && (
              <span className="text-xs text-muted-foreground">Pick from the catalog — or ask.</span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {(['metric', 'table', 'chart', 'pivot'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVizOverride(v)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] ${
                    viz === v
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v}
                </button>
              ))}
              {onSave && (
                <button
                  type="button"
                  onClick={() => onSave(effectiveDraft)}
                  disabled={!result}
                  className="ml-1 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <Save className="h-3 w-3" /> Save
                </button>
              )}
            </span>
          </div>

          {error && (
            <div className="rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2 text-sm text-amber-800">
              {error.message}
              {!!error.suggestions?.length && (
                <span className="ml-1 text-amber-700">Did you mean: {error.suggestions.join(', ')}?</span>
              )}
            </div>
          )}
          {loading && !result && <ReportLoading message="Running…" />}
          {spec && !error && <Widget spec={spec} />}
          {!hasSelection && !error && (
            <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              The result canvas — pick a measure to start.
            </div>
          )}
        </div>

        {/* Explain panel */}
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Explain</div>
          {result ? (
            <>
              <div className="text-muted-foreground">
                {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}
                {result.total !== undefined && <> of {result.total.toLocaleString()}</>}
                {elapsed !== null && <> · {elapsed} ms</>}
                {result.truncated_at !== undefined && <> · truncated at {result.truncated_at.toLocaleString()}</>}
              </div>
              {result.sql ? (
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">
                  {result.sql}
                </pre>
              ) : (
                <div className="text-muted-foreground">The engine returned no SQL for this run.</div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground">Run a query to see its compiled SQL and timing.</div>
          )}
        </div>
      </div>
    </div>
  )
}
