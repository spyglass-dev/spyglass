# examples/

Generic, domain-agnostic cube definitions used by the docs and the demo. They
exist only to show the **cube format** — Spyglass ships no host-specific cubes.

- [`example.yml`](./example.yml) — two small cubes (`Events`, `Orders`) with
  measures and dimensions, including the mandatory `tenant: true` scope column.

Serve these with the standalone binary by pointing `REPORTING_CUBES` at this
directory:

```bash
REPORTING_CUBES=./examples cargo run -p spyglass --bin spyglass-server
# POST http://127.0.0.1:8088/query
```

To build cubes for your **own** database instead of using these, see
[Generating cubes with distri](../web/docs/generating-cubes.md).
