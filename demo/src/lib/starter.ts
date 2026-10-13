/** The report the demo opens on: the store at a glance, built from the same
 *  bound-widget JSON the agent writes. */
import type { Report } from '@spyglassjs/ui'
import { DEFAULT_FACETS } from './model'

export function storeOverview(): Report {
  return {
    title: 'Store overview',
    description: 'Lighthouse Outfitters — revenue, demand and what is selling.',
    facets: DEFAULT_FACETS,
    filters: { datePreset: 'last_90d' },
    widgets: [
      { type: 'bound', id: 'w-revenue', as: 'metric', query: { measures: ['Orders.revenue'] }, trend: true, filters: { compare: 'previous_period' }, w: 1 },
      { type: 'bound', id: 'w-orders', as: 'metric', query: { measures: ['Orders.count'] }, trend: true, filters: { compare: 'previous_period' }, w: 1 },
      { type: 'bound', id: 'w-aov', as: 'metric', query: { measures: ['Orders.aov'] }, trend: true, filters: { compare: 'previous_period' }, w: 1 },
      { type: 'bound', id: 'w-cr', as: 'metric', query: { measures: ['Traffic.conversion_rate'] }, trend: true, filters: { compare: 'previous_period' }, w: 1 },
      {
        type: 'bound',
        id: 'w-trend',
        as: 'chart',
        mark: 'area',
        title: 'Revenue by week',
        query: { measures: ['Orders.revenue'], timeDimensions: [{ dimension: 'Orders.ordered_at', granularity: 'week' }] },
        filters: { compare: 'previous_year' },
        w: 3,
      },
      {
        type: 'bound',
        id: 'w-channel',
        as: 'chart',
        mark: 'arc',
        title: 'Revenue by channel',
        query: { measures: ['Orders.revenue'], dimensions: ['Orders.channel'], order: [{ member: 'Orders.revenue', desc: true }] },
        w: 1,
      },
      {
        type: 'bound',
        id: 'w-category',
        as: 'chart',
        mark: 'bar',
        title: 'Category revenue and margin',
        query: {
          measures: ['OrderItems.revenue', 'OrderItems.margin'],
          dimensions: ['OrderItems.category'],
          order: [{ member: 'OrderItems.revenue', desc: true }],
        },
        y: 'OrderItems.revenue',
        y2: 'OrderItems.margin',
        w: 2,
      },
      {
        type: 'bound',
        id: 'w-mix',
        as: 'pivot',
        title: 'Revenue by region and device',
        query: { measures: ['Orders.revenue'], dimensions: ['Orders.region', 'Orders.device'] },
        pivot: { scale: 'sequential', totals: { row: 'sum', col: 'sum', rowLabel: 'Total', colLabel: 'Total' } },
        w: 2,
      },
      {
        type: 'bound',
        id: 'w-products',
        as: 'table',
        title: 'Top products',
        query: {
          measures: ['OrderItems.revenue', 'OrderItems.units', 'OrderItems.margin', 'OrderItems.return_rate'],
          dimensions: ['OrderItems.product', 'OrderItems.category'],
          order: [{ member: 'OrderItems.revenue', desc: true }],
          limit: 8,
        },
        w: 4,
      },
      {
        type: 'bound',
        id: 'w-conversion',
        as: 'chart',
        mark: 'bar',
        title: 'Conversion by channel and device',
        query: {
          measures: ['Traffic.conversion_rate'],
          dimensions: ['Traffic.channel', 'Traffic.device'],
          order: [{ member: 'Traffic.conversion_rate', desc: true }],
        },
        x: 'Traffic.channel',
        color: 'Traffic.device',
        stack: false,
        w: 2,
      },
      {
        type: 'bound',
        id: 'w-customers',
        as: 'chart',
        mark: 'hbar',
        title: 'Top customers',
        query: {
          measures: ['Orders.revenue'],
          dimensions: ['Orders.customer_id'],
          order: [{ member: 'Orders.revenue', desc: true }],
          limit: 8,
        },
        w: 2,
      },
    ],
  }
}
