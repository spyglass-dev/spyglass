/**
 * The demo app: a report canvas, the analyst beside it, and a dataset that
 * lives in this tab. Everything a host normally supplies — the query runner,
 * the model, saved reports — is supplied here by the browser engine and
 * IndexedDB, which is the whole point: swap `engine.runQuery` for a fetch to
 * `/query` and this is a production reporting page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DistriProvider } from '@distri/react'
import {
  DEFAULT_REPORT_EXPORTERS,
  ReportCanvas,
  ReportEmptyState,
  createReportStore,
  dateRangeLabel,
  drillStepLabel,
  memberIndex,
  newReportId,
  resolveFacets,
  resolveReport,
  useReportModel,
  withWidgetIds,
  type QueryRunner,
  type Report,
  type ReportHost,
  type SavedReport,
  type WidgetOutcome,
} from '@spyglassjs/ui'
import { BarChart3, Check, Cpu, Database, Download, FilePlus2, LayoutDashboard, Save, Sparkles, Telescope } from 'lucide-react'
import type { BrowserEngine } from './engine/browserEngine'
import { reportCollection } from './lib/idb'
import { cubeCapsFrom, DEFAULT_FACETS, FACET_SOURCES } from './lib/model'
import { storeOverview } from './lib/starter'
import { AnalystPanel, STARTERS } from './components/AnalystPanel'
import { DataView } from './components/DataView'

const DISTRI_URL = (import.meta.env.VITE_DISTRI_API_URL || 'https://api.distri.dev/v1').replace(/\/+$/, '')

/** A short-lived distri token from the dev server (see vite.config.ts). */
async function fetchToken(): Promise<{ token: string; workspaceId: string } | null> {
  const r = await fetch('/api/token', { method: 'POST' }).catch(() => null)
  if (!r?.ok) return null
  const j = (await r.json()) as { access_token?: string; workspace_id?: string }
  return j.access_token && j.workspace_id ? { token: j.access_token, workspaceId: j.workspace_id } : null
}
const WORKING_KEY = 'spyglass-demo:working'

const store = createReportStore(reportCollection)

function blankReport(): Report {
  return { title: 'Untitled report', facets: DEFAULT_FACETS, filters: { datePreset: 'last_90d' }, widgets: [] }
}

function loadWorking(): { report: Report; savedId: string | null } | null {
  try {
    const raw = localStorage.getItem(WORKING_KEY)
    return raw ? (JSON.parse(raw) as { report: Report; savedId: string | null }) : null
  } catch {
    return null
  }
}

export function App({ engine, bootMs }: { engine: BrowserEngine; bootMs: number }) {
  const [auth, setAuth] = useState<{ token: string; workspaceId: string } | null | undefined>(undefined)
  useEffect(() => void fetchToken().then(setAuth), [])
  const config = useMemo(
    () =>
      auth && {
        baseUrl: DISTRI_URL,
        workspaceId: auth.workspaceId,
        accessToken: auth.token,
        onTokenRefresh: async () => (await fetchToken())?.token ?? null,
      },
    [auth],
  )
  const app = <Workspace engine={engine} bootMs={bootMs} analyst={Boolean(config)} />
  return config ? <DistriProvider config={config}>{app}</DistriProvider> : app
}

function Workspace({ engine, bootMs, analyst }: { engine: BrowserEngine; bootMs: number; analyst: boolean }) {
  const meta = engine.meta
  const cubeCaps = useMemo(() => cubeCapsFrom(meta), [meta])
  const members = useMemo(() => memberIndex(meta), [meta])
  const working = useMemo(loadWorking, [])
  const [report, setReport] = useState<Report>(() => working?.report ?? storeOverview())
  const [savedId, setSavedId] = useState<string | null>(working?.savedId ?? null)
  const [saved, setSaved] = useState<SavedReport[]>([])
  const [justSaved, setJustSaved] = useState(false)
  const [tab, setTab] = useState<'report' | 'data'>('report')
  const [analystOpen, setAnalystOpen] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [sources, setSources] = useState<Record<string, { value: string; label: string }[]>>({})

  const outcomes = useRef<Map<string, WidgetOutcome>>(new Map())
  const reportRef = useRef(report)
  reportRef.current = report
  const savedIdRef = useRef(savedId)
  savedIdRef.current = savedId

  // Keep the working report across reloads.
  useEffect(() => {
    localStorage.setItem(WORKING_KEY, JSON.stringify({ report, savedId }))
  }, [report, savedId])

  const refreshSaved = useCallback(() => void store.listReports().then(setSaved), [])
  useEffect(refreshSaved, [refreshSaved])

  // Facet options come from the data, not from a list someone typed.
  useEffect(() => {
    void Promise.all(
      Object.entries(FACET_SOURCES).map(async ([key, member]) => {
        const values = await engine.values(member)
        return [key, values.map((v) => ({ value: String(v.value), label: String(v.label ?? v.value) }))] as const
      }),
    ).then((pairs) => setSources(Object.fromEntries(pairs)))
  }, [engine])
  const facets = useMemo(() => resolveFacets(report.facets ?? DEFAULT_FACETS, sources), [report.facets, sources])

  const runQuery = useCallback<QueryRunner>((query) => engine.runQuery(query), [engine])

  // The agent's view of the model: validation for its queries, explore_data,
  // and a digest generated FROM the model.
  const modelClient = useMemo(() => ({ fetchMeta: async () => meta, runQuery: engine.runQuery }), [meta, engine])
  const model = useReportModel(modelClient, {
    scopeNote: 'One store, loaded in the browser. There is no tenant scope; every row is queryable.',
  })

  const host = useMemo<ReportHost>(
    () => ({
      getReport: () => reportRef.current,
      setReport: (next) => setReport({ ...next, widgets: withWidgetIds(next.widgets) }),
      onBuilt: () => setSavedId(null),
      getSavedId: () => savedIdRef.current,
      getOutcomes: () => outcomes.current,
    }),
    [],
  )

  const describeReport = useCallback(() => {
    const r = reportRef.current
    const widgets = r.widgets
      .map((w, i) => {
        const id = (w as { id?: string }).id ?? `#${i}`
        const outcome = outcomes.current.get(id)
        const title = (w as { title?: string }).title ?? (w as { query?: { measures?: string[] } }).query?.measures?.join(', ') ?? w.type
        return `${id}: ${title}${outcome ? ` (${outcome.status})` : ''}`
      })
      .join('; ')
    const drill = (r.drill ?? []).map(drillStepLabel).join(' > ')
    return [
      `Open report: "${r.title}" (${savedIdRef.current ? 'saved' : 'draft'}), ${r.widgets.length} widgets.`,
      `Date range: ${dateRangeLabel(r.filters ?? {})}.`,
      drill ? `The reader has drilled into: ${drill}.` : '',
      widgets ? `Widgets: ${widgets}.` : 'The report is empty.',
    ]
      .filter(Boolean)
      .join(' ')
  }, [])

  const save = async () => {
    const id = savedId ?? newReportId()
    await store.saveReport(id, report)
    setSavedId(id)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1600)
    refreshSaved()
  }

  const open = (r: Report, id: string | null) => {
    setReport(r)
    setSavedId(id)
    setTab('report')
  }

  const exportReport = async (exporterId: string) => {
    setExportOpen(false)
    const exporter = DEFAULT_REPORT_EXPORTERS.find((x) => x.id === exporterId)
    if (!exporter) return
    const doc = await resolveReport(report, { runQuery, cubeCaps, members })
    await exporter.run({ doc, title: report.title })
  }

  const ask = (text: string) => {
    setAnalystOpen(true)
    setPending(text)
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Telescope className="h-4 w-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">Spyglass</span>
        </div>
        <span className="text-muted-foreground/50">/</span>
        <span className="text-sm font-medium">Lighthouse Outfitters</span>
        <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700" title={`Booted in ${Math.round(bootMs)} ms`}>
          <Cpu className="h-3 w-3" /> In your browser · DuckDB + WASM
        </span>

        <nav className="ml-6 flex items-center gap-1 rounded-lg bg-muted p-0.5">
          {(
            [
              ['report', 'Report', LayoutDashboard],
              ['data', 'Data', Database],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors ${tab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <button type="button" onClick={() => setExportOpen((o) => !o)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-muted">
              <Download className="h-3.5 w-3.5" /> Export
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-9 z-30 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
                {DEFAULT_REPORT_EXPORTERS.map((x) => (
                  <button key={x.id} type="button" onClick={() => void exportReport(x.id)} className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted">
                    {x.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => void save()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90">
            {justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {justSaved ? 'Saved' : savedId ? 'Save' : 'Save report'}
          </button>
          {!analystOpen && (
            <button type="button" onClick={() => setAnalystOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 text-sm font-medium text-primary hover:bg-primary/10">
              <Sparkles className="h-3.5 w-3.5" /> Analyst
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Reports rail ─────────────────────────────────────────────── */}
        <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-card/60 p-3">
          <button type="button" onClick={() => open(blankReport(), null)} className="mb-2 inline-flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:border-primary/50 hover:text-primary">
            <FilePlus2 className="h-4 w-4" /> New report
          </button>
          <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Starter</div>
          <RailItem active={!savedId && report.title === 'Store overview'} onClick={() => open(storeOverview(), null)} label="Store overview" />
          <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Saved in this browser</div>
          {saved.length === 0 && <div className="px-2 text-xs text-muted-foreground">Nothing saved yet.</div>}
          {saved.map((s) => (
            <RailItem key={s.id} active={savedId === s.id} onClick={() => open(s.body, s.id)} label={s.title} />
          ))}
        </aside>

        {/* ── Main ─────────────────────────────────────────────────────── */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {tab === 'data' ? (
            <DataView engine={engine} meta={meta} />
          ) : (
            <div className="mx-auto flex max-w-[1180px] flex-col gap-2 px-6 py-5">
              <input
                value={report.title}
                onChange={(e) => setReport({ ...report, title: e.target.value })}
                aria-label="Report title"
                className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground"
              />
              {report.description && <p className="-mt-1 text-sm text-muted-foreground">{report.description}</p>}
              {report.widgets.length === 0 ? (
                <div className="mt-6">
                  {agentBusy ? (
                    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <Sparkles className="h-5 w-5 animate-pulse" />
                      </div>
                      <div className="text-lg font-semibold">The analyst is working</div>
                      <p className="text-sm text-muted-foreground">It looks at the data first, then builds the report here. Widgets appear as they are added.</p>
                      <div className="mt-4 grid w-full grid-cols-4 gap-3">
                        {[1, 1, 1, 1, 4, 2, 2].map((w, i) => (
                          <div key={i} style={{ gridColumn: `span ${w}` }} className={`animate-pulse rounded-xl border border-border bg-card ${w === 1 ? 'h-20' : 'h-32'}`} />
                        ))}
                      </div>
                    </div>
                  ) : (
                  <ReportEmptyState
                    onDescribe={ask}
                    title="Ask a question, get a report"
                    subtitle="The analyst picks the measures, builds the widgets and lays them out. Click anything to drill in."
                    placeholder="e.g. How did the holiday season compare to last year?"
                    suggestions={STARTERS.map((s) => ({ label: s.label, prompt: s.prompt }))}
                    cta="Ask"
                  />
                  )}
                </div>
              ) : (
                <ReportCanvas
                  generating={agentBusy}
                  report={report}
                  onChange={setReport}
                  onResolved={(o) => (outcomes.current = o)}
                  runQuery={runQuery}
                  cubeCaps={cubeCaps}
                  members={members}
                  facets={facets}
                />
              )}
            </div>
          )}
        </main>

        {/* ── Analyst ──────────────────────────────────────────────────── */}
        {analystOpen &&
          (analyst ? (
            <AnalystPanel
              host={host}
              ctx={model.ctx}
              digest={model.digest}
              describeReport={describeReport}
              pending={pending}
              onPendingSent={() => setPending(null)}
              onClose={() => setAnalystOpen(false)}
              onBusyChange={setAgentBusy}
            />
          ) : (
            <aside className="flex w-[400px] shrink-0 flex-col items-center justify-center gap-3 border-l border-border bg-card px-8 text-center">
              <BarChart3 className="h-8 w-8 text-muted-foreground" />
              <div className="text-sm font-semibold">Connect the analyst</div>
              <p className="text-sm text-muted-foreground">
                Set <code className="rounded bg-muted px-1 text-xs">DISTRI_API_KEY</code> and <code className="rounded bg-muted px-1 text-xs">DISTRI_WORKSPACE_ID</code> in <code className="rounded bg-muted px-1 text-xs">demo/.env</code> and push{' '}
                <code className="rounded bg-muted px-1 text-xs">agents/spyglass_analyst.md</code> to your distri workspace. The report, drilling and exports work without it.
              </p>
            </aside>
          ))}
      </div>
    </div>
  )
}

function RailItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-left text-sm ${active ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'}`}
    >
      <LayoutDashboard className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
    </button>
  )
}
