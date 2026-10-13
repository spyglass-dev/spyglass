/**
 * The model's presentation facts, keyed by member — what a widget should call
 * a field and how to format it, read from `/meta` instead of guessed from the
 * member name. `Orders.aov` is "Average order value" in dollars because the
 * cube says so; humanizing the name gives "Aov" and a bare number.
 */
import type { CubeModelMeta } from './querybuilder'
import { asValueFormat, type ValueFormat } from './types'

export interface MemberInfo {
  title?: string
  format?: ValueFormat
  unit?: string
  description?: string
  /** `drill: { entity }` of a dimension. */
  entity?: string
}

export type MemberIndex = Record<string, MemberInfo>

/** Index every measure and dimension in the model by its `Cube.member` key. */
export function memberIndex(meta: CubeModelMeta | null | undefined): MemberIndex {
  const out: MemberIndex = {}
  for (const cube of meta?.cubes ?? []) {
    for (const m of cube.measures) {
      out[m.member] = { title: m.title, format: asValueFormat(m.format), unit: m.unit, description: m.description }
    }
    for (const d of cube.dimensions) {
      out[d.member] = {
        title: d.title,
        format: d.type === 'time' ? 'date' : undefined,
        unit: d.unit,
        description: d.description,
        entity: d.drill_entity,
      }
    }
  }
  return out
}

/** The info for a result key — a `__label` companion shares its dimension's. */
export function memberInfo(members: MemberIndex | undefined, key: string): MemberInfo | undefined {
  if (!members) return undefined
  return members[key] ?? members[key.replace(/__label$/, '')]
}
