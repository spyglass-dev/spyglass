import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@distri/react/globals.css'
import './index.css'
import { Check, Loader2, Telescope } from 'lucide-react'
import cubesYaml from './dataset/cubes.yml?raw'
import seedSql from './dataset/seed.sql?raw'
import { createBrowserEngine, type BrowserEngine } from './engine/browserEngine'
import { Smoke } from './smoke'
import { App } from './App'

type Step = 'engine' | 'compiler' | 'data' | 'ready'
const STEPS: [Step, string][] = [
  ['engine', 'Starting DuckDB in the browser'],
  ['compiler', 'Loading the spyglass compiler (Rust → WASM)'],
  ['data', 'Generating two years of store data'],
]

function Boot({ step, error }: { step: Step | null; error: string | null }) {
  const at = step ? STEPS.findIndex(([s]) => s === step) : -1
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-[380px] rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Telescope className="h-4 w-4" />
          </div>
          <span className="font-semibold">Spyglass</span>
        </div>
        {error ? (
          <pre data-boot-error className="whitespace-pre-wrap text-xs text-rose-600">{error}</pre>
        ) : (
          <ol className="flex flex-col gap-3">
            {STEPS.map(([s, label], i) => (
              <li key={s} className={`flex items-center gap-2.5 text-sm ${i > at ? 'text-muted-foreground/60' : ''}`}>
                {i < at || step === 'ready' ? (
                  <Check className="h-4 w-4 text-emerald-600" />
                ) : i === at ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <span className="h-4 w-4 rounded-full border border-border" />
                )}
                {label}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

let bootOnce: Promise<BrowserEngine> | null = null
const progress = new Set<(s: Step, ms: number) => void>()

function Root() {
  const [engine, setEngine] = useState<BrowserEngine | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [bootMs, setBootMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // One engine per page, even when StrictMode runs this effect twice.
    bootOnce ??= createBrowserEngine({
      cubesYaml,
      seedSql,
      onProgress: (s, ms) => progress.forEach((fn) => fn(s, ms)),
    })
    const listener = (s: Step, ms: number) => {
      setStep(s)
      if (s === 'ready') setBootMs(ms)
    }
    progress.add(listener)
    bootOnce.then(setEngine, (e) => setError(e instanceof Error ? e.stack ?? e.message : String(e)))
    return () => void progress.delete(listener)
  }, [])
  if (!engine || error) return <Boot step={step} error={error} />
  if (new URLSearchParams(location.search).has('smoke')) return <Smoke engine={engine} />
  return <App engine={engine} bootMs={bootMs} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
