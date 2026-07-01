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

const charts: ReportDoc = {
  title: 'Chart gallery',
  description: 'Vega-Lite behind the compact ChartSpec, plus a raw vlSpec.',
  widgets: [
    {
      type: 'chart',
      title: 'Submissions by status (stacked)',
      w: 2,
      chart: {
        mark: 'bar',
        x: 'week',
        y: 'count',
        color: 'status',
        series: [
          { week: 'W1', status: 'graded', count: 12 },
          { week: 'W1', status: 'needs review', count: 4 },
          { week: 'W2', status: 'graded', count: 15 },
          { week: 'W2', status: 'needs review', count: 6 },
        ],
      },
    },
    {
      type: 'chart',
      title: 'Avg score trend',
      w: 2,
      chart: {
        mark: 'line',
        x: 'date',
        y: 'avg',
        format: 'percent',
        series: [
          { date: '2026-04-01', avg: 68 },
          { date: '2026-05-01', avg: 74 },
          { date: '2026-06-01', avg: 81 },
        ],
      },
    },
    {
      type: 'chart',
      title: 'Raw Vega-Lite (heatmap)',
      w: 4,
      chart: {
        mark: 'bar',
        y: 'v',
        series: [
          { student: 'Ada', skill: 'Grammar', v: 3 },
          { student: 'Ada', skill: 'Fluency', v: 2 },
          { student: 'Ben', skill: 'Grammar', v: 1 },
          { student: 'Ben', skill: 'Fluency', v: 4 },
        ],
        vlSpec: {
          mark: 'rect',
          encoding: {
            x: { field: 'skill', type: 'nominal', title: null },
            y: { field: 'student', type: 'nominal', title: null },
            color: { field: 'v', type: 'quantitative', title: 'Mastery' },
          },
          height: 120,
        },
      },
    },
  ],
}

export const ChartGallery = {
  render: () => <ReportView doc={charts} />,
}
