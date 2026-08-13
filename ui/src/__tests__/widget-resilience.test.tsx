/**
 * A report is largely agent-authored, so a widget can carry a shape nothing
 * validated. Two real cases, both from one generated report:
 *
 *  - `y` as an ARRAY of measures — "submissions and graded on one chart". It
 *    reached `field.replace`, threw, and WHITE-SCREENED the whole page.
 *  - anything else that throws during render, which must stay local.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Chart } from '../components/Chart'
import { WidgetBoundary } from '../components/WidgetBoundary'

afterEach(cleanup)

const series = [
  { 'Submissions.submitted_at': '2026-08-01', 'Submissions.count': 10, 'Submissions.graded': 4 },
  { 'Submissions.submitted_at': '2026-08-02', 'Submissions.count': 12, 'Submissions.graded': 9 },
]

describe('a chart with several measures', () => {
  const chart = (y: unknown) =>
    ({ type: 'chart', chart: { mark: 'line', x: 'Submissions.submitted_at', y, series } }) as never

  it('renders instead of throwing — the exact widget that white-screened the app', () => {
    expect(() =>
      render(<Chart spec={chart(['Submissions.count', 'Submissions.graded'])} />),
    ).not.toThrow()
  })

  it('still renders a single-measure array and a plain string', () => {
    expect(() => render(<Chart spec={chart(['Submissions.count'])} />)).not.toThrow()
    cleanup()
    expect(() => render(<Chart spec={chart('Submissions.count')} />)).not.toThrow()
  })

  it('survives a null y rather than taking the page with it', () => {
    expect(() => render(<Chart spec={chart(null)} />)).not.toThrow()
  })
})

describe('WidgetBoundary', () => {
  const Boom = () => {
    throw new Error('widget exploded')
  }

  it('shows an error card instead of unmounting the report', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <WidgetBoundary title="Daily submissions">
          <Boom />
        </WidgetBoundary>
        <p>the rest of the report</p>
      </div>,
    )
    expect(screen.getByText(/Couldn’t load this widget/i)).toBeTruthy()
    // The point: everything else still rendered.
    expect(screen.getByText('the rest of the report')).toBeTruthy()
    spy.mockRestore()
  })

  it('tells the host, so the failure can reach the agent as an outcome', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    render(
      <WidgetBoundary onError={onError}>
        <Boom />
      </WidgetBoundary>,
    )
    expect(onError).toHaveBeenCalledWith('widget exploded')
    spy.mockRestore()
  })

  it('passes a healthy widget straight through', () => {
    render(
      <WidgetBoundary>
        <p>fine</p>
      </WidgetBoundary>,
    )
    expect(screen.getByText('fine')).toBeTruthy()
  })
})
