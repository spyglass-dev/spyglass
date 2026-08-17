/**
 * Multi-series BOUND charts.
 *
 * `Chart` has always rendered a `color` split and an array `y` — the compact
 * encoding was built for it. The bound path could not ASK for either:
 * `draftToWidgetSpec` dropped both fields, so "submissions per day, one line
 * per workspace" was expressible in a static chart, in a raw Vega spec, and
 * nowhere in a query-backed widget. Every host and agent authoring bound
 * widgets could only draw one series.
 */
import { describe, it, expect } from 'vitest'
import { draftToWidgetSpec, type QueryResultLite, type WidgetDraft } from '../querybuilder'
import { widgetToDraft, type BoundWidget } from '../report'
import type { ChartSpec } from '../types'

const result: QueryResultLite = {
  columns: [
    { key: 'Submissions.workspace_id', kind: 'dimension' },
    { key: 'Submissions.workspace_id__label', kind: 'label' },
    { key: 'Submissions.created_at', kind: 'time' },
    { key: 'Submissions.count', kind: 'measure' },
  ],
  rows: [
    { 'Submissions.workspace_id': 'w1', 'Submissions.workspace_id__label': 'Ada High', 'Submissions.created_at': '2026-08-01', 'Submissions.count': 10 },
    { 'Submissions.workspace_id': 'w2', 'Submissions.workspace_id__label': 'Bell School', 'Submissions.created_at': '2026-08-01', 'Submissions.count': 4 },
  ],
}

const draft = (over: Partial<WidgetDraft> = {}): WidgetDraft => ({
  as: 'chart',
  mark: 'line',
  query: { measures: ['Submissions.count'], dimensions: ['Submissions.workspace_id'] },
  ...over,
})

const chartOf = (d: WidgetDraft) => (draftToWidgetSpec(d, result) as ChartSpec).chart

describe('a bound chart split into series', () => {
  it('carries the color field through to the spec', () => {
    expect(chartOf(draft({ color: 'Submissions.workspace_id', x: 'Submissions.created_at' })).color).toBe(
      'Submissions.workspace_id__label',
    )
  })

  it('colors by the LABEL column when the dimension declares one', () => {
    // A legend of UUIDs names nothing. The id stays the group-by; the name is
    // what the reader sees.
    const chart = chartOf(draft({ color: 'Submissions.workspace_id' }))
    expect(chart.color).toBe('Submissions.workspace_id__label')
  })

  it('falls back to the member itself when there is no label column', () => {
    const unlabelled: QueryResultLite = {
      columns: [
        { key: 'Submissions.status', kind: 'dimension' },
        { key: 'Submissions.count', kind: 'measure' },
      ],
      rows: [{ 'Submissions.status': 'graded', 'Submissions.count': 3 }],
    }
    const chart = (
      draftToWidgetSpec(draft({ color: 'Submissions.status' }), unlabelled) as ChartSpec
    ).chart
    expect(chart.color).toBe('Submissions.status')
  })

  it('does not default x to the split member — that drew one bar per series', () => {
    // With `dimensions: [workspace_id]` + a daily bucket the first non-measure
    // column IS the workspace, so the old default put workspaces on the x axis
    // and lost the time series entirely.
    expect(chartOf(draft({ color: 'Submissions.workspace_id' })).x).toBe('Submissions.created_at')
  })

  it('passes stack:false through for grouped bars, and omits it when unset', () => {
    expect(chartOf(draft({ mark: 'bar', color: 'Submissions.workspace_id', stack: false })).stack).toBe(false)
    expect('stack' in chartOf(draft())).toBe(false)
  })

  it('keeps an array y — several measures on one chart', () => {
    const y = ['Submissions.count', 'Submissions.graded']
    expect(chartOf(draft({ y })).y).toEqual(y)
  })

  it('round-trips through widgetToDraft, so editing a widget cannot silently flatten it', () => {
    const widget: BoundWidget = {
      type: 'bound',
      ...draft({ color: 'Submissions.workspace_id', stack: false, y: ['Submissions.count'] }),
    }
    const back = widgetToDraft(widget)
    expect(back.color).toBe('Submissions.workspace_id')
    expect(back.stack).toBe(false)
    expect(back.y).toEqual(['Submissions.count'])
  })
})
