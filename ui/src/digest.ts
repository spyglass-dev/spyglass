/**
 * Model digest — the compact, agent-readable description of the semantic
 * model, GENERATED from `/meta` so it cannot drift from the deployed cubes.
 * Small enough for a system prompt; featured members lead, descriptions and
 * units ride along, joins and segments are one line each.
 */
import type { CubeMeta, CubeModelMeta, DimensionMeta, MeasureMeta } from './querybuilder'
import { viewsDigest, type ViewRegistry } from './views'

const featuredFirst = <T extends { featured?: boolean; name: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => Number(b.featured ?? false) - Number(a.featured ?? false))

function measureLine(m: MeasureMeta): string {
  const bits = [m.member]
  if (m.title && m.title !== m.name) bits.push(`"${m.title}"`)
  if (m.unit) bits.push(`(${m.unit})`)
  if (m.featured) bits.push('★')
  if (m.description) bits.push(`— ${m.description}`)
  return bits.join(' ')
}

function dimensionLine(d: DimensionMeta): string {
  const bits = [d.member]
  if (d.type === 'time') bits.push('[time]')
  if (d.label) bits.push(`(labelled by ${d.label})`)
  if (d.drill_entity) bits.push(`→ ${d.drill_entity}`)
  if (d.filterable) bits.push('[filterable]')
  if (d.featured) bits.push('★')
  if (d.description) bits.push(`— ${d.description}`)
  return bits.join(' ')
}

function cubeBlock(cube: CubeMeta): string {
  const lines: string[] = []
  lines.push(`## ${cube.title ?? cube.name}${cube.description ? ` — ${cube.description}` : ''}`)
  const measures = featuredFirst(cube.measures)
  if (measures.length) {
    lines.push('measures:')
    for (const m of measures) lines.push(`  - ${measureLine(m)}`)
  }
  // Tenant dimensions are scope plumbing, not something an agent queries.
  const dims = featuredFirst(cube.dimensions.filter((d) => !d.tenant))
  if (dims.length) {
    lines.push('dimensions:')
    for (const d of dims) lines.push(`  - ${dimensionLine(d)}`)
  }
  if (cube.segments?.length) {
    lines.push(
      `segments: ${cube.segments.map((s) => `${s.member}${s.description ? ` (${s.description})` : ''}`).join(', ')}`,
    )
  }
  if (cube.joins?.length) {
    lines.push(`joins: ${cube.joins.map((j) => `${j.relationship} → ${j.target}`).join(', ')}`)
  }
  if (cube.drill_members?.length) {
    lines.push(`row mode projects: ${cube.drill_members.join(', ')}`)
  }
  return lines.join('\n')
}

/** The digest: one markdown-ish string per model. Deterministic for a given
 *  `/meta` payload. Pass the host's view registry to include registered
 *  views — the manifest is what lets an agent place a view by name. */
export function modelDigest(meta: CubeModelMeta, views?: ViewRegistry): string {
  const header = [
    '# Data model',
    'Query shape: { measures: ["Cube.measure"], dimensions: ["Cube.dimension"],',
    '  timeDimensions: [{ dimension, granularity?, dateRange? }], filters: [{ member, operator, values }],',
    '  order?, limit?, offset?, includeTotal? }. Relative dateRange strings like "last 30 days" are supported.',
    'Look before you build: run explore_data first to see the shape of an answer.',
    '',
  ].join('\n')
  const body = header + meta.cubes.map(cubeBlock).join('\n\n')
  const viewsPart = views ? viewsDigest(views) : ''
  return viewsPart ? `${body}\n\n${viewsPart}` : body
}
