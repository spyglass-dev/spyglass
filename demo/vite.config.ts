import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `POST /api/token` in dev: a short-lived distri token that can read agents
 * and run completions. The API key stays in this Node process (DISTRI_* vars
 * without the VITE_ prefix are never sent to the browser). A static deploy
 * puts the same endpoint behind a function; without one, the demo runs with
 * the analyst switched off.
 */
function devToken(env: Record<string, string>): Plugin {
  return {
    name: 'dev-token',
    configureServer(server) {
      server.middlewares.use('/api/token', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        if (!env.DISTRI_API_KEY || !env.DISTRI_WORKSPACE_ID) {
          res.statusCode = 503
          return res.end('{"error":"DISTRI_API_KEY / DISTRI_WORKSPACE_ID not set"}')
        }
        const r = await fetch(`${env.DISTRI_BASE_URL || 'https://api.distri.dev/v1'}/token`, {
          method: 'POST',
          headers: { 'x-api-key': env.DISTRI_API_KEY, 'X-Workspace-Id': env.DISTRI_WORKSPACE_ID, 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'workspace', permissions: { Agent: 1, Completion: 8 } }),
        })
        const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_at?: string }
        res.setHeader('content-type', 'application/json')
        res.statusCode = r.ok ? 200 : 502
        res.end(JSON.stringify({ access_token: j.access_token, expires_at: j.expires_at, workspace_id: env.DISTRI_WORKSPACE_ID }))
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DISTRI_')
  return {
    plugins: [react(), devToken(env)],
    resolve: { dedupe: ['react', 'react-dom'] },
    // DuckDB's worker and the compiler's wasm are loaded by URL; keep them out
    // of dependency pre-bundling.
    optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
    server: { port: 5198, host: '127.0.0.1', fs: { allow: ['..'] } },
  }
})
