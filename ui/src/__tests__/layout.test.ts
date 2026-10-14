/**
 * The default grid. The case that prompted it: two metric tiles beside a
 * two-column chart stretched to the chart's height and looked empty.
 */
import { describe, it, expect } from 'vitest'
import { planGrid } from '../layout'

const m = (w?: number) => ({ metric: true, w })
const c = (w?: number) => ({ metric: false, w })

describe('planGrid', () => {
  it('stacks metrics that share a row with a chart, and widens the chart', () => {
    expect(planGrid([m(1), m(1), c(2)])).toEqual([
      { kind: 'stack', indices: [0, 1], w: 1 },
      { kind: 'single', index: 2, w: 3 },
    ])
  })

  it('leaves a full row of four metrics alone', () => {
    expect(planGrid([m(), m(), m(), m()]).map((x) => x.w)).toEqual([1, 1, 1, 1])
  })

  it('gives two metrics alone two columns each', () => {
    expect(planGrid([m(1), m(1)])).toEqual([
      { kind: 'single', index: 0, w: 2 },
      { kind: 'single', index: 1, w: 2 },
    ])
  })

  it('fills a short row by widening its widest chart', () => {
    expect(planGrid([c(2), c(1)])).toEqual([
      { kind: 'single', index: 0, w: 3 },
      { kind: 'single', index: 1, w: 1 },
    ])
  })

  it('keeps order and starts a new row when the next widget does not fit', () => {
    const cells = planGrid([c(4), m(1), m(1), m(1), c(2)])
    expect(cells[0]).toEqual({ kind: 'single', index: 0, w: 4 })
    // Row 2: three metrics (3 cols). Row 3: the chart alone, widened to 4.
    expect(cells.slice(1, 4).map((x) => x.w)).toEqual([1, 1, 1])
    expect(cells[4]).toEqual({ kind: 'single', index: 4, w: 4 })
  })

  it('a single metric beside a chart stays a tile; the chart takes the rest', () => {
    expect(planGrid([m(1), c(2)])).toEqual([
      { kind: 'single', index: 0, w: 1, compact: true },
      { kind: 'single', index: 1, w: 3 },
    ])
  })
})
