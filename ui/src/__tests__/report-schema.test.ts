import { describe, it, expect } from 'vitest'
import { validateReport, validateFilterSpec, validateAgainstSchema, FACET_SPEC_SCHEMA } from '../report.schema'

describe('report schema validation', () => {
  it('accepts a minimal valid report', () => {
    const r = validateReport({ title: 'X', widgets: [] })
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('accepts a report with a facet spec + filters + extra fields', () => {
    const r = validateReport({
      title: 'Class overview',
      widgets: [{ type: 'bound', as: 'metric', query: { measures: ['Submissions.count'] } }],
      facets: [
        { key: 'class_id', label: 'Class', required: true, single: true, source: 'classes' },
        { key: 'status', label: 'Status', alwaysOn: true, variant: 'chips', options: [{ value: 'graded', label: 'Graded' }] },
      ],
      filters: { datePreset: 'last_30d', facets: { class_id: ['c1'] } },
      created_at: 123, // additionalProperties:true at the top level
    })
    expect(r.valid).toBe(true)
  })

  it('flags a missing required field', () => {
    const r = validateReport({ widgets: [] })
    expect(r.valid).toBe(false)
    expect(r.errors).toContainEqual({ path: '$.title', message: 'is required' })
  })

  it('flags a wrong type', () => {
    const r = validateReport({ title: 5, widgets: [] })
    expect(r.errors).toContainEqual({ path: '$.title', message: 'expected string' })
  })

  it('rejects an unknown property on a facet (additionalProperties:false)', () => {
    const r = validateFilterSpec([{ key: 'status', label: 'Status', group_by: 'week' }])
    expect(r.valid).toBe(false)
    expect(r.errors).toContainEqual({ path: '$[0].group_by', message: 'is not a permitted property' })
  })

  it('flags a missing facet key', () => {
    const r = validateFilterSpec([{ label: 'Status' }])
    expect(r.errors).toContainEqual({ path: '$[0].key', message: 'is required' })
  })

  it('enforces the variant enum', () => {
    const errs = validateAgainstSchema(FACET_SPEC_SCHEMA, { key: 'k', label: 'L', variant: 'pie' })
    expect(errs).toContainEqual({ path: '$.variant', message: 'must be one of: chips, menu' })
  })

  it('enforces the datePreset enum', () => {
    const r = validateReport({ title: 'X', widgets: [], filters: { datePreset: 'last_5min' } })
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.path === '$.filters.datePreset')).toBe(true)
  })
})
