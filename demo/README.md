# Spyglass demo: ask your data

A report canvas with a distri analyst beside it, over a dataset that lives in
the browser tab. Ask a question, the analyst builds widgets, click a bar to
drill, ask a follow-up about the slice you drilled into, save, export.

No server and no database. The spyglass compiler (`../wasm`, Rust built to
WebAssembly) turns each widget query into the same SQL the Postgres engine
would run, DuckDB-WASM executes it, and the compiler assembles the result
(totals, row cap, previous period). Swap `engine.runQuery` for a `fetch` to a
spyglass server and nothing above it changes.

```sh
pnpm install
pnpm --filter @spyglass/demo wasm   # needs wasm-pack + the wasm32-unknown-unknown target
cp demo/.env.example demo/.env      # DISTRI_API_KEY / DISTRI_WORKSPACE_ID for the analyst
distri agents push demo/agents/spyglass_analyst.md
pnpm --filter @spyglass/demo dev    # http://127.0.0.1:5198
```

`?smoke` runs representative queries (buckets, compare, gap fill, labels,
records, contains) through the engine and shows pass/fail.

| File | What it is |
|---|---|
| `src/dataset/seed.sql` | Lighthouse Outfitters, a fictional outdoor-gear store: two years ending yesterday, ~45k orders, deterministic (hash-seeded) |
| `src/dataset/cubes.yml` | the model: Orders, Products sold, Customers, Web traffic |
| `src/engine/browserEngine.ts` | WASM compiler + DuckDB-WASM behind the `runQuery` / `meta` / `values` a host normally serves |
| `src/components/AnalystPanel.tsx` | distri `<Chat>` with `buildReportTools` — the tools run in the browser |
| `agents/spyglass_analyst.md` | the agent definition pushed to distri |

Without `DISTRI_API_KEY` the report, drilling, filters and exports still work;
the analyst panel says what is missing. The key stays in the Vite dev server,
which mints short-lived tokens at `POST /api/token`.
