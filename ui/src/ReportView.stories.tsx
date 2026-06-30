/**
 * Storybook stories for the reporting widgets. CSF3, framework-agnostic
 * (no hard Storybook import) so the package stays light; a workspace-level
 * Storybook can pick these up.
 */
import { ReportView } from './components/ReportView'
import type { ReportDoc } from './types'

const sample: ReportDoc = {
  title: 'P5 English — Weekly Review',
  description: 'Grading-first snapshot.',
  widgets: [
    { type: 'metric', value: 5, label: 'To grade', w: 1 },
    { type: 'metric', value: 82, label: 'Completion', format: 'percent', w: 1, delta: { value: 5, trend: 'up', suffix: 'pp' } },
    { type: 'metric', value: 74, label: 'Avg score', format: 'percent', w: 1 },
    { type: 'metric', value: 3, label: 'At risk', w: 1 },
    {
      type: 'chart',
      title: 'Submissions by activity',
      w: 2,
      chart: { mark: 'bar', x: 'activity', y: 'count', series: [
        { activity: 'Essay 1', count: 18 },
        { activity: 'Quiz 2', count: 12 },
        { activity: 'Worksheet 3', count: 7 },
      ] },
    },
    {
      type: 'table',
      title: 'At-risk students',
      w: 2,
      columns: [
        { key: 'name', label: 'Student' },
        { key: 'avg', label: 'Avg', format: 'percent', align: 'right' },
        { key: 'missing', label: 'Missing', align: 'right' },
      ],
      rows: [
        { name: 'Ben', avg: 41, missing: 3 },
        { name: 'Cara', avg: 55, missing: 2 },
      ],
    },
  ],
}

const meta = {
  title: 'Reporting/ReportView',
  component: ReportView,
}
export default meta

export const ClassReview = {
  render: () => <ReportView doc={sample} />,
}
