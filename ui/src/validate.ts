/**
 * Query validation against the model — the agent-repair loop's other half.
 * A bad member returns `{ ok: false, error, suggestions }` so an agent fixes
 * its query instead of the user seeing a broken widget.
 */
import type { CubeModelMeta, WidgetQuery } from './querybuilder'

export type QueryValidation =
  | { ok: true }
  | { ok: false; error: string; suggestions: string[] }

/** Cheap edit distance (capped) for close-name suggestions. */
function editDistance(a: string, b: string, cap = 4): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = prev[j]
      prev[j] = next
    }
  }
  return prev[b.length]
}

function suggest(bad: string, candidates: string[], max = 3): string[] {
  const needle = bad.toLowerCase()
  const scored = candidates
    .map((c) => {
      const hay = c.toLowerCase()
      const contains = hay.includes(needle.split('.').pop() ?? needle) ? 0 : 1
      return { c, score: contains * 2 + editDistance(needle, hay, 6) }
    })
    .sort((a, b) => a.score - b.score)
  return scored.slice(0, max).map((s) => s.c)
}

const bad = (error: string, suggestions: string[] = []): QueryValidation => ({
  ok: false,
  error,
  suggestions,
})

/**
 * Validate a query's members against `/meta`. Checks existence and role
 * (a dimension in `measures` is flagged, and vice versa); suggestions come
 * from the whole model, closest first.
 */
export function validateQuery(query: WidgetQuery, meta: CubeModelMeta): QueryValidation {
  const measures = new Set<string>()
  const dimensions = new Set<string>()
  const timeDims = new Set<string>()
  const segments = new Set<string>()
  for (const cube of meta.cubes) {
    for (const m of cube.measures) measures.add(m.member)
    for (const d of cube.dimensions) {
      dimensions.add(d.member)
      if (d.type === 'time') timeDims.add(d.member)
    }
    for (const s of cube.segments ?? []) segments.add(s.member)
  }
  const all = [...measures, ...dimensions]

  if (!(query.measures?.length || query.dimensions?.length))
    return bad('The query selects nothing — add at least one measure or dimension.')

  for (const m of query.measures ?? []) {
    if (measures.has(m)) continue
    if (dimensions.has(m)) return bad(`\`${m}\` is a dimension — move it to \`dimensions\`.`, [m])
    return bad(`Unknown measure \`${m}\`.`, suggest(m, [...measures]))
  }
  for (const d of query.dimensions ?? []) {
    if (dimensions.has(d)) continue
    if (measures.has(d)) return bad(`\`${d}\` is a measure — move it to \`measures\`.`, [d])
    return bad(`Unknown dimension \`${d}\`.`, suggest(d, [...dimensions]))
  }
  for (const t of query.timeDimensions ?? []) {
    if (timeDims.has(t.dimension)) continue
    if (dimensions.has(t.dimension))
      return bad(`\`${t.dimension}\` is not a time dimension.`, suggest(t.dimension, [...timeDims]))
    return bad(`Unknown time dimension \`${t.dimension}\`.`, suggest(t.dimension, [...timeDims]))
  }
  for (const f of query.filters ?? []) {
    if (!all.includes(f.member)) return bad(`Unknown filter member \`${f.member}\`.`, suggest(f.member, all))
  }
  for (const o of query.order ?? []) {
    if (!all.includes(o.member)) return bad(`Unknown order member \`${o.member}\`.`, suggest(o.member, all))
  }
  return { ok: true }
}
