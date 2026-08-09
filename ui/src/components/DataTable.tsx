/** DataTable — deprecated alias kept for API compatibility. The table widget
 *  is `DataGrid` now (server-driven sort/paging, CSV, virtualization); this
 *  renders one in static mode. */
import type { TableSpec } from '../types'
import { DataGrid } from './DataGrid'

/** @deprecated Use `DataGrid`. */
export function DataTable({ spec }: { spec: TableSpec }) {
  return <DataGrid spec={spec} />
}
