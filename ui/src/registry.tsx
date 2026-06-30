/**
 * Custom-widget registry — how a host (e.g. Zippy) plugs in its own widgets
 * that "define their own data format". A custom widget receives its `CustomSpec`
 * (with `data`/`props`) and renders however it likes. `ReportView` resolves
 * `{ type: 'custom', component }` against the registry passed to it.
 */
import type { ComponentType } from 'react'
import type { CustomSpec } from './types'

export interface CustomWidgetProps {
  spec: CustomSpec
}

export type CustomWidget = ComponentType<CustomWidgetProps>

export type WidgetRegistry = Record<string, CustomWidget>

export const emptyRegistry: WidgetRegistry = {}
