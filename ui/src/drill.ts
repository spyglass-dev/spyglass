/**
 * Drill — the model-driven click contract (decision record: reporting
 * contracts v2, §2). Drill belongs to the MODEL, not the UI: cubes annotate
 * dimensions with `drill: { entity }`, and every table in every report becomes
 * drillable with no per-report wiring.
 *
 * The UI EMITS `DrillEvent`; the host optionally registers a `DrillRouter`
 * (routing is host policy, emitting is framework behavior). With no router —
 * or no route for the event's entity — the default is DRILL-DOWN: add
 * `member = value` as a filter, re-run in place, push a poppable breadcrumb.
 * Drill must be useful before any host wires anything.
 */
import type { QueryFilter, WidgetQuery } from './querybuilder'

/** A click on a dimension value, resolved through the model's annotations. */
export interface DrillEvent {
  /** Qualified dimension member, e.g. `"Orders.customer_id"`. */
  member: string
  value: string | number | boolean | null
  /** Resolved display label, when the model provided one (`__label`). */
  label?: string
  /** From the dimension's `drill: { entity }` annotation. */
  entity?: string
}

/** Host routing table: entity → handler. An entity with no route falls back
 *  to the default drill-down. */
export type DrillRouter = Record<string, (value: DrillEvent['value'], event: DrillEvent) => void>

/** The drill trail — orderly, poppable. Element N was clicked while N-1's
 *  filters were in effect. */
export type DrillTrail = DrillEvent[]

/** Human text for a trail step: `"Customer: Karl Seal"`. */
export function drillStepLabel(step: DrillEvent): string {
  const dim = step.member.split('.').pop() ?? step.member
  const name = dim.replace(/_id$/, '').replace(/_/g, ' ')
  return `${name}: ${step.label ?? String(step.value)}`
}

/**
 * Apply the drill trail to one widget's query — the filter-in-place default.
 * Each step becomes an `equals` filter. Cross-cube: a step applies to a
 * widget when the widget's cube declares the same UNQUALIFIED dimension
 * (mirroring how report facets apply); the member is re-qualified to the
 * widget's cube. A later step on the same member replaces the earlier one.
 */
export function applyDrillTrail(
  query: WidgetQuery,
  trail: DrillTrail,
  cube: string | undefined,
  cubeDims: string[] | undefined,
): WidgetQuery {
  if (!trail.length || !cube) return query
  const filters: QueryFilter[] = [...(query.filters ?? [])]
  let touched = false
  for (const step of trail) {
    const [stepCube, dim] = [step.member.split('.')[0], step.member.split('.').slice(1).join('.')]
    const member = stepCube === cube ? step.member : cubeDims?.includes(dim) ? `${cube}.${dim}` : null
    if (!member) continue
    const existing = filters.findIndex((f) => f.member === member && f.operator === 'equals')
    const filter: QueryFilter = { member, operator: 'equals', values: [step.value] }
    if (existing >= 0) filters[existing] = filter
    else filters.push(filter)
    touched = true
  }
  return touched ? { ...query, filters } : query
}

/** Route an event: the host's router wins when it has the entity; otherwise
 *  `drillDown` runs (the default). Returns true when routed. */
export function routeDrill(
  event: DrillEvent,
  router: DrillRouter | undefined,
  drillDown: (event: DrillEvent) => void,
): boolean {
  const route = event.entity ? router?.[event.entity] : undefined
  if (route) {
    route(event.value, event)
    return true
  }
  drillDown(event)
  return false
}
