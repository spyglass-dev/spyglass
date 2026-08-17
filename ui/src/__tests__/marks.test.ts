/**
 * Not everything is a bar.
 *
 * The compact encoding shipped with bar / line / area / point / progress, so a
 * report that wanted a share of a whole drew ten columns, and a ranking of
 * long names drew `question_evalua…` under each one. Two marks close that:
 * `arc` (a donut, bounded) and `hbar`.
 */
import { describe, it, expect } from 'vitest'
import { toVegaLiteForTest } from '../components/Chart'

const mix = [
  { type: 'logged_in', n: 1021 },
  { type: 'submission_graded', n: 664 },
  { type: 'content_created', n: 148 },
  { type: 'streak_milestone', n: 134 },
  { type: 'question_evaluated', n: 71 },
  { type: 'class_created', n: 44 },
  { type: 'student_invited', n: 41 },
  { type: 'course_published', n: 36 },
]

describe('a donut', () => {
  const chart = (series: Record<string, unknown>[]) =>
    toVegaLiteForTest({ mark: 'arc', x: 'type', y: 'n', series })

  it('encodes the value as an angle and the category as colour', () => {
    const vl = chart(mix.slice(0, 4))
    const enc = vl.encoding as Record<string, { field: string; type: string }>
    expect(enc.theta.field).toBe('n')
    expect(enc.theta.type).toBe('quantitative')
    expect(enc.color.field).toBe('type')
  })

  it('folds the tail into "Other" past six slices', () => {
    // A pie of ten close slices is the chart people rightly complain about.
    const values = (chart(mix).data as { values: Record<string, unknown>[] }).values
    expect(values).toHaveLength(6)
    expect(values[values.length - 1].type).toBe('Other')
    // Nothing is lost — the tail is summed, not dropped.
    const total = values.reduce((s, r) => s + (r.n as number), 0)
    expect(total).toBe(mix.reduce((s, r) => s + r.n, 0))
  })

  it('leaves six or fewer alone, in the order the query returned them', () => {
    const values = (chart(mix.slice(0, 5)).data as { values: Record<string, unknown>[] }).values
    expect(values.map((v) => v.type)).toEqual([
      'logged_in',
      'submission_graded',
      'content_created',
      'streak_milestone',
      'question_evaluated',
    ])
  })

  it('carries each slice’s share, so nobody estimates an angle', () => {
    const values = (chart(mix.slice(0, 2)).data as { values: Record<string, unknown>[] }).values
    const shares = values.map((v) => Math.round(v._share as number))
    expect(shares).toEqual([61, 39])
  })
})

describe('bars on their side', () => {
  it('puts the category on y and the value on x', () => {
    const vl = toVegaLiteForTest({ mark: 'hbar', x: 'type', y: 'n', series: mix })
    const enc = vl.encoding as Record<string, { field: string; type: string; sort?: unknown }>
    expect(enc.y.field).toBe('type')
    expect(enc.y.type).toBe('nominal')
    expect(enc.x.field).toBe('n')
    expect(enc.x.type).toBe('quantitative')
    // Still the query's order, not alphabetical.
    expect(enc.y.sort).toBeNull()
  })

  it('grows a row at a time instead of squeezing twenty into 220px', () => {
    const vl = toVegaLiteForTest({ mark: 'hbar', x: 'type', y: 'n', series: mix })
    expect(vl.height).toEqual({ step: 24 })
    expect(vl.width).toBe('container')
  })

  it('gives the label room — the whole point of turning it sideways', () => {
    const vl = toVegaLiteForTest({ mark: 'hbar', x: 'type', y: 'n', series: mix })
    const y = (vl.encoding as Record<string, { axis?: { labelLimit?: number } }>).y
    expect(y.axis?.labelLimit).toBeGreaterThanOrEqual(150)
  })
})
