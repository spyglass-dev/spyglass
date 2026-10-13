import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import cubesYaml from './dataset/cubes.yml?raw'
import seedSql from './dataset/seed.sql?raw'
import { createBrowserEngine, type BrowserEngine } from './engine/browserEngine'
import { Smoke } from './smoke'

function Root() {
  const [engine, setEngine] = useState<BrowserEngine | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    createBrowserEngine({ cubesYaml, seedSql }).then(setEngine, (e) => setError(String(e)))
  }, [])
  if (error) return <pre data-boot-error>{error}</pre>
  if (!engine) return <p>Loading…</p>
  return <Smoke engine={engine} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
