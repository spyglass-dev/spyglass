import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // DuckDB's worker and the compiler's wasm are loaded by URL; keep them out
  // of dependency pre-bundling.
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { port: 5198, host: '127.0.0.1', fs: { allow: ['..'] } },
})
