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
})
