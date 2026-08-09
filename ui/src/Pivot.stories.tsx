/**
 * Pivot stories — named for the STATE each one shows. The sparse story is the
 * important one: absent (`—`), null (`n/a`), and a real `0` side by side.
 *
 * Domain-agnostic sample data in the Pagila DVD-rental shape
 * (Customers × Films → a rating measure), so nothing here is tied to a
 * specific host product.
 */
import { MAX_PIVOT_COLS, Pivot } from './components/Pivot'
import type { PivotSpec } from './types'

const meta = {
  title: 'Reporting/Pivot',
  component: Pivot,
}
export default meta

const cell = (customer: string, film: string, rating: number | null) => ({
  'Reviews.customer_id': customer.toLowerCase().replace(' ', '-'),
  'Reviews.customer_id__label': customer,
  'Reviews.film_id': film.toLowerCase().replace(/ /g, '-'),
  'Reviews.film_id__label': film,
  'Reviews.avg_rating': rating,
})

const base: Omit<PivotSpec, 'data'> = {
  type: 'pivot',
  title: 'Average rating — customer × film',
  rows: ['Reviews.customer_id'],
  cols: ['Reviews.film_id'],
  measure: 'Reviews.avg_rating',
  format: 'number',
}

/** Absent vs null vs zero: the three states that must never look alike.
 *  Karl never rated Chamber Italian (—), Eleanor's Grosse Wonderful rating is
 *  null (n/a), and Clara really gave Airport Pollock a 0. */
const sparse: PivotSpec = {
  ...base,
  data: [
    cell('Karl Seal', 'Airport Pollock', 4),
    cell('Karl Seal', 'Grosse Wonderful', 5),
    cell('Eleanor Hunt', 'Airport Pollock', 3),
    cell('Eleanor Hunt', 'Grosse Wonderful', null),
    cell('Eleanor Hunt', 'Chamber Italian', 5),
    cell('Clara Shaw', 'Airport Pollock', 0),
    cell('Clara Shaw', 'Chamber Italian', 2),
  ],
}

export const SparseMissingVsZeroVsNull = {
  render: () => <Pivot spec={sparse} />,
}

export const WithTotalsAndSequentialShading = {
  render: () => (
    <Pivot
      spec={{
        ...sparse,
        totals: { row: 'avg', col: 'avg' },
        scale: 'sequential',
      }}
    />
  ),
}

export const DivergingShadingZeroFilled = {
  render: () => (
    <Pivot
      spec={{
        ...sparse,
        empty: 'zero',
        scale: 'diverging',
        totals: { row: 'avg' },
      }}
    />
  ),
}

const wide: PivotSpec = {
  ...base,
  title: 'Capped — 30 films across, 24 shown',
  data: Array.from({ length: MAX_PIVOT_COLS + 6 }, (_, i) => [
    cell('Karl Seal', `Film ${String(i + 1).padStart(2, '0')}`, (i % 5) + 1),
    cell('Eleanor Hunt', `Film ${String(i + 1).padStart(2, '0')}`, ((i + 2) % 5) + 1),
  ]).flat(),
  totals: { row: 'avg' },
  scale: 'sequential',
}

export const CappedWithTruncationNotice = {
  render: () => <Pivot spec={wide} />,
}

export const EmptyDataset = {
  render: () => <Pivot spec={{ ...base, data: [] }} />,
}
