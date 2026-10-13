import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Dates render in the reader's zone; pin it so a date assertion means the
    // same on a laptop in UTC-7 and on CI.
    env: { TZ: 'UTC' },
    server: {
      deps: {
        // vega-embed's CJS build require()s vega's ESM build, which has a
        // top-level await: Node rejects that (ERR_REQUIRE_ASYNC_MODULE) and the
        // release job fails on unhandled rejections. Let Vite transform them.
        inline: [/vega/],
      },
    },
  },
})
