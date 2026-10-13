/** What the canvas and the agent need to know about the model, derived from
 *  `/meta` (here: the WASM compiler's `meta()`), never hand-written. */
import type { CubeCapsMap, CubeModelMeta, FacetSpec } from '@spyglassjs/ui'

/** Per cube: which dimensions a report filter can reach, and the time field a
 *  date range applies to (the featured time dimension, else the first). */
export function cubeCapsFrom(meta: CubeModelMeta): CubeCapsMap {
  const caps: CubeCapsMap = {}
  for (const cube of meta.cubes) {
    const times = cube.dimensions.filter((d) => d.type === 'time')
    caps[cube.name] = {
      dims: cube.dimensions.filter((d) => d.filterable).map((d) => d.name),
      timeField: (times.find((d) => d.featured) ?? times[0])?.name,
    }
  }
  return caps
}

/** The filters a report offers by default: the dimensions most cubes share. */
export const DEFAULT_FACETS: FacetSpec[] = [
  { key: 'region', label: 'Region', source: 'region', alwaysOn: true },
  { key: 'channel', label: 'Channel', source: 'channel', alwaysOn: true },
  { key: 'device', label: 'Device', source: 'device' },
  { key: 'category', label: 'Category', source: 'category' },
]

/** Where each facet's options come from (`values()` on a cube that has it). */
export const FACET_SOURCES: Record<string, string> = {
  region: 'Orders.region',
  channel: 'Orders.channel',
  device: 'Orders.device',
  category: 'OrderItems.category',
}
