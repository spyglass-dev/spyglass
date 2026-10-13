/**
 * A spyglass engine that runs entirely in the browser.
 *
 * The spyglass compiler (Rust, compiled to WASM) turns a WidgetQuery into SQL
 * exactly as the server does; DuckDB-WASM executes it over tables loaded into
 * the page; the compiler assembles the result (totals, row cap, previous
 * period). Swap this for `fetch('/query')` and nothing above it changes.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbMvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import initCompiler, { Spyglass } from '../../../wasm/pkg/spyglass_wasm.js'
import compilerWasm from '../../../wasm/pkg/spyglass_wasm_bg.wasm?url'
import type { CubeModelMeta, QueryResultLite, WidgetQuery } from '@spyglassjs/ui'

type Scalar = string | number | boolean | null
interface Statement {
  sql: string
  params: Scalar[]
}
interface Plan {
  id: number
  main: Statement
  prev?: Statement
}

export interface BrowserEngine {
  meta: CubeModelMeta
  runQuery: (query: WidgetQuery) => Promise<QueryResultLite>
  /** Distinct values of a `filterable` dimension, for filter pickers. */
  values: (member: string, search?: string) => Promise<{ value: Scalar; label?: string; count: number }[]>
  /** Raw SQL for the data tab — read-only exploration of the loaded tables. */
  sql: (statement: string) => Promise<Record<string, unknown>[]>
  /** Milliseconds the last query spent in DuckDB. */
  lastQueryMs: () => number
}

export interface BrowserEngineOptions {
  cubesYaml: string
  /** SQL that creates and fills the tables the cubes read. */
  seedSql: string
  /** Rows a single query may return before it is marked truncated. */
  maxRows?: number
}

/** Arrow hands back BigInt for 64-bit integers; JSON and the widgets want numbers. */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return value.toISOString()
  return value
}

function toRows(table: { toArray(): { toJSON(): Record<string, unknown> }[] }): Record<string, unknown>[] {
  return table.toArray().map((row) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row.toJSON())) out[key] = plain(value)
    return out
  })
}

/** DuckDB binds `$n` positionally; the compiler casts each placeholder
 *  (`$1::timestamptz`), so every value is bound as text, as Postgres does. */
function bindable(params: Scalar[]): (string | null)[] {
  return params.map((p) => (p === null ? null : String(p)))
}

export async function createBrowserEngine(opts: BrowserEngineOptions): Promise<BrowserEngine> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdbMvp, mainWorker: duckdbMvpWorker },
    eh: { mainModule: duckdbEh, mainWorker: duckdbEhWorker },
  })
  const worker = new Worker(bundle.mainWorker!)
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  const conn = await db.connect()
  // Buckets and relative dates resolve in UTC, matching the server's default.
  await conn.query(`set TimeZone = 'UTC'`).catch(() => undefined)

  await initCompiler({ module_or_path: compilerWasm })
  const compiler = new Spyglass(opts.cubesYaml)
  const meta = JSON.parse(compiler.meta()) as CubeModelMeta

  // DuckDB's `query` runs one statement at a time from a multi-statement
  // script fine; the seed is a script.
  await conn.query(opts.seedSql)

  let lastMs = 0
  async function exec(stmt: Statement): Promise<Record<string, unknown>[]> {
    const started = performance.now()
    try {
      if (stmt.params.length === 0) return toRows(await conn.query(stmt.sql))
      const prepared = await conn.prepare(stmt.sql)
      try {
        return toRows(await prepared.query(...bindable(stmt.params)))
      } finally {
        await prepared.close()
      }
    } finally {
      lastMs = performance.now() - started
    }
  }

  return {
    meta,
    async runQuery(query) {
      const plan = JSON.parse(
        compiler.plan(JSON.stringify(query), undefined, Date.now(), opts.maxRows ?? 5000),
      ) as Plan
      try {
        const rows = await exec(plan.main)
        const prev = plan.prev ? await exec(plan.prev) : undefined
        return JSON.parse(
          compiler.assemble(plan.id, JSON.stringify(rows), prev ? JSON.stringify(prev) : undefined),
        ) as QueryResultLite
      } catch (err) {
        compiler.discard(plan.id)
        throw err
      }
    },
    async values(member, search) {
      const stmt = JSON.parse(compiler.values(member, search, 200, undefined)) as Statement
      return (await exec(stmt)) as { value: Scalar; label?: string; count: number }[]
    },
    async sql(statement) {
      return toRows(await conn.query(statement))
    },
    lastQueryMs: () => lastMs,
  }
}
