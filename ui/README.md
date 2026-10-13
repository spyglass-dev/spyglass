# @spyglass/ui

React widgets that render a Spyglass `ReportDoc`: metric, table, data grid, pivot,
chart (Vega-Lite) and note, plus a registry for your own custom widgets. Pairs with
the [`spyglass`](https://github.com/spyglass-dev/spyglass) engine, which produces the
data these specs carry.

```sh
pnpm add @spyglass/ui react react-dom
```

```tsx
import { ReportView, type ReportDoc } from '@spyglass/ui'

const doc: ReportDoc = await fetch('/api/reports/sales/run', { method: 'POST', body: '{}' }).then(r => r.json())

<ReportView doc={doc} registry={{}} />
```

Layout uses Tailwind utility classes, so add the package to your Tailwind `content`:

```js
content: ['./src/**/*.{ts,tsx}', './node_modules/@spyglass/ui/dist/**/*.js']
```

Every color routes through `var(--rpt-*, fallback)` custom properties (`--rpt-bg`,
`--rpt-text`, `--rpt-accent`, ...). Set them on an ancestor to theme the widgets.
`lucide-react` is an optional peer for icons.

Docs: [embedding](https://github.com/spyglass-dev/spyglass/blob/main/web/docs/embedding.md)
and [widgets](https://github.com/spyglass-dev/spyglass/blob/main/web/docs/widgets.md).

Apache-2.0.
