/**
 * One broken widget must not take the report down with it.
 *
 * A report is largely agent-authored, so a widget can carry a shape nothing
 * validated: a chart whose `y` was an array, a custom component that throws on
 * a null. Without a boundary that becomes an unhandled render error, React
 * unmounts the whole tree, and the user gets a WHITE SCREEN — no report, no
 * filter bar, no way back. That happened: a two-measure line chart wiped the
 * page.
 *
 * The trade is deliberate. A widget that renders an error is a visible, local,
 * fixable failure, and the agent can read it back through `get_report`'s
 * outcomes. A blank page is none of those things.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { WidgetError } from './WidgetError'

interface Props {
  children: ReactNode
  /** Shown on the error card, so the user knows WHICH widget failed. */
  title?: string
  /** Reported to the host, which surfaces it to the agent as an outcome. */
  onError?: (message: string) => void
}

interface State {
  message: string | null
}

export class WidgetBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep the stack in the console: the card shows the message, and whoever
    // is debugging needs the component trace.
    console.error('[spyglass] widget failed to render:', error, info.componentStack)
    this.props.onError?.(error instanceof Error ? error.message : String(error))
  }

  /** Re-render after the widget is edited: a new child means a new attempt. */
  componentDidUpdate(prev: Props) {
    if (this.state.message && prev.children !== this.props.children) {
      this.setState({ message: null })
    }
  }

  render() {
    if (this.state.message !== null) {
      // WidgetError reads a CustomSpec, the same shape a failed resolve
      // produces — so a render crash and a query failure look identical to the
      // reader, which is right: both mean "this panel did not work".
      return (
        <WidgetError
          spec={{
            type: 'custom',
            component: 'widget_error',
            title: this.props.title,
            data: { message: 'This widget could not be rendered.', detail: this.state.message },
          }}
        />
      )
    }
    return this.props.children
  }
}
