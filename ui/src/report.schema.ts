/**
 * JSON Schema (draft-07) for the reporting framework's data model — the
 * canonical, host-agnostic contract for a report document and its declared
 * filter spec. This is the framework's tooling artifact: agents author against
 * it, hosts validate against it, and it documents the wire shape independently
 * of the TypeScript types (which it mirrors 1:1).
 *
 * `FACET_SPEC_SCHEMA` is the filter-spec fragment on its own, so a host/agent
 * tool can declare just the `facets` array (e.g. in a `create_report` tool's
 * parameters) without pulling in the whole report schema.
 */

/** Schema for one declared facet (see `FacetSpec`). */
export const FACET_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'label'],
  properties: {
    key: { type: 'string', description: 'Dimension key the host filters on (e.g. "status", "class_id").' },
    label: { type: 'string' },
    required: { type: 'boolean', description: 'Mandatory — always shown, prompted until set; the host may auto-pick.' },
    alwaysOn: { type: 'boolean', description: 'Always shown on the bar (not behind "+ Filter"), but not prompted.' },
    single: { type: 'boolean', description: 'Single-select (default: multi).' },
    variant: { type: 'string', enum: ['chips', 'menu'], description: 'Control style (default: chips ≤6 options, menu otherwise).' },
    options: {
      type: 'array',
      description: 'Inline static options. Omit when the host binds a dynamic list via `source`.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'label'],
        properties: { value: { type: 'string' }, label: { type: 'string' } },
      },
    },
    source: { type: 'string', description: 'Name of a dynamic option list the host binds at render (e.g. "classes"). Keeps options live, not frozen in the doc.' },
  },
} as const

/** Schema for the report's declared filter spec — an array of facets. */
export const FILTER_SPEC_SCHEMA = {
  type: 'array',
  description: 'Declared filters: what facets the report offers and which are mandatory. Selected values live separately under `filters`.',
  items: FACET_SPEC_SCHEMA,
} as const

/** Schema for the selected filter values (`ReportFilters`). */
export const REPORT_FILTERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    datePreset: {
      type: 'string',
      enum: ['last_1h', 'last_24h', 'last_7d', 'last_30d', 'last_90d', 'this_week', 'this_month', 'ytd', 'all'],
    },
    dateFrom: { type: 'string' },
    dateTo: { type: 'string' },
    facets: {
      type: 'object',
      description: 'Selected values per facet key.',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

/** Schema for a whole report document. Widgets stay permissive (`object`) —
 *  the widget vocabulary is validated by the widget types, not here. */
export const REPORT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Report',
  type: 'object',
  additionalProperties: true,
  required: ['title', 'widgets'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    facets: FILTER_SPEC_SCHEMA,
    filters: REPORT_FILTERS_SCHEMA,
    widgets: { type: 'array', items: { type: 'object' } },
  },
} as const

// ── Validation ───────────────────────────────────────────────────────────────
//
// A tiny, dependency-free validator for the draft-07 subset the schemas above
// use (type / properties / required / additionalProperties / enum / items). It
// walks the schema object itself, so validation can never drift from the
// declared schema — there is one source of truth.

/** A single schema violation. */
export interface SchemaError {
  /** JSON path to the offending value, e.g. `$.facets[0].key`. */
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: SchemaError[]
}

type JsonSchema = Record<string, unknown>

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'null': return value === null
    default: return true
  }
}

/** Validate `value` against `schema`, collecting every violation. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = '$'): SchemaError[] {
  const errors: SchemaError[] = []
  const type = schema.type as string | undefined

  if (type && !typeMatches(type, value)) {
    errors.push({ path, message: `expected ${type}` })
    return errors // further checks assume the type held
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push({ path, message: `must be one of: ${(schema.enum as unknown[]).join(', ')}` })
  }
  if (type === 'object' && isPlainObject(value)) {
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in value)) errors.push({ path: `${path}.${req}`, message: 'is required' })
    }
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {}
    const additional = schema.additionalProperties
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validateAgainstSchema(props[k], v, `${path}.${k}`))
      else if (additional === false) errors.push({ path: `${path}.${k}`, message: 'is not a permitted property' })
      else if (isPlainObject(additional)) errors.push(...validateAgainstSchema(additional as JsonSchema, v, `${path}.${k}`))
    }
  }
  if (type === 'array' && Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(schema.items as JsonSchema, item, `${path}[${i}]`)))
  }
  return errors
}

/** Validate a whole report document against `REPORT_SCHEMA`. */
export function validateReport(doc: unknown): ValidationResult {
  const errors = validateAgainstSchema(REPORT_SCHEMA, doc)
  return { valid: errors.length === 0, errors }
}

/** Validate a declared filter spec (the `facets` array) on its own. */
export function validateFilterSpec(facets: unknown): ValidationResult {
  const errors = validateAgainstSchema(FILTER_SPEC_SCHEMA, facets)
  return { valid: errors.length === 0, errors }
}
