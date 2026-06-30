import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // In dev, @spyglass/ui resolves to its TS source (the package's
  // "development" export condition), so Vite transpiles it live with HMR —
  // no build step. Dedupe React so the linked source shares the app's copy.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5197,
    // Proxy the spyglass-server API so the app calls it same-origin (no CORS).
    // Override the target with SPYGLASS_API_TARGET if the server isn't on 8088.
    proxy: {
      '/api': {
        target: process.env.SPYGLASS_API_TARGET || 'http://127.0.0.1:8088',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
