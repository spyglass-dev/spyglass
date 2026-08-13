/**
 * `useReportModel` — the agent's view of the deployed model.
 *
 * `/meta` is fetched once and turned into the two things a report agent needs:
 * a `ToolContext` (query validation + `explore_data`) and a digest generated
 * FROM the model, so the agent's description of the data cannot drift from the
 * cubes actually deployed. Hosts that hand-write that description ship an agent
 * that is wrong one cube change later.
 *
 * A `/meta` that fails degrades rather than throws: the agent keeps its tools
 * and loses query validation. A reporting panel that renders nothing because
 * the engine is unconfigured is a worse failure than one that answers without
 * autocomplete.
 */
import { useEffect, useMemo, useState } from 'react'
import { modelDigest } from '../digest'
import type { CubeModelMeta, QueryResultLite, WidgetQuery } from '../querybuilder'
import type { ToolContext } from '../distri'
import type { ViewRegistry } from '../views'
import { buildExampleIndex, type ExampleIndex } from './references'

/** The engine surface this hook needs — structural, so any host client fits. */
export interface ModelClient {
  fetchMeta(): Promise<CubeModelMeta>
  runQuery(query: WidgetQuery): Promise<QueryResultLite>
}

export interface ReportModelOptions {
  /**
   * One host line prepended to the digest, saying what the agent is looking at
   * — which tenant scope is already applied server-side, and therefore what it
   * must NOT filter by itself. This is the only part of the digest a host
   * writes, and the only part that differs between two consoles over the same
   * engine.
   */
  scopeNote?: string
  /** Host views the agent may place with `add_report_view`. */
  views?: ViewRegistry
}

export interface ReportModel {
  ctx: ToolContext
  /** The digest for this host, or null until `/meta` resolves. */
  digest: string | null
  /** True once `/meta` has settled either way. Hosts wait on this so the agent
   *  never takes a first message with no model to reason about. */
  ready: boolean
  /** The raw model, for hosts that render pickers over it. */
  meta: CubeModelMeta | null
  /** The reference-query index, for hosts that surface examples in the UI. */
  examples: ExampleIndex | null
}

export function useReportModel(client: ModelClient, opts: ReportModelOptions = {}): ReportModel {
  const [meta, setMeta] = useState<CubeModelMeta | null>(null)
  const [ready, setReady] = useState(false)
  const { scopeNote, views } = opts

  useEffect(() => {
    let cancelled = false
    client
      .fetchMeta()
      .then((m) => !cancelled && setMeta(m))
      .catch(() => {})
      .finally(() => !cancelled && setReady(true))
    return () => {
      cancelled = true
    }
  }, [client])

  // Built ONCE per `/meta`, not per tool call: the examples ride on a payload
  // that is already loaded and cached, so retrieval costs nothing per question.
  const examples = useMemo<ExampleIndex | null>(
    () => (meta ? buildExampleIndex(meta) : null),
    [meta],
  )

  const ctx = useMemo<ToolContext>(
    () => ({
      ...(meta ? { meta } : {}),
      runQuery: (query) => client.runQuery(query),
      ...(views ? { views } : {}),
      ...(examples && examples.examples.length ? { examples } : {}),
    }),
    [meta, client, views, examples],
  )

  const digest = useMemo(() => {
    if (!meta) return null
    const body = modelDigest(meta, views)
    return scopeNote ? `${scopeNote}\n${body}` : body
  }, [meta, scopeNote, views])

  return { ctx, digest, ready, meta, examples }
}
