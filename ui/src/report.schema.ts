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
