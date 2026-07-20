/**
 * ReportEmptyState — the "describe what you want" hero for an empty report (or
 * an empty widget builder). Host-agnostic: it just collects a natural-language
 * request and hands it to `onDescribe` (the host routes it to its agent).
 * Tailwind tokens.
 */
import { useState } from 'react'

export interface ReportEmptyStateProps {
  onDescribe: (text: string) => void
  title?: string
  subtitle?: string
  placeholder?: string
  /** Quick-start prompts rendered as chips. */
  suggestions?: string[]
  /** Verb on the primary button. */
  cta?: string
  /** Optional secondary action (e.g. "add a widget by hand"). */
  onSecondary?: () => void
  secondaryLabel?: string
}

export function ReportEmptyState({
  onDescribe,
  title = 'Build a report',
  subtitle = 'Describe what you want to see; it builds live widgets you can refine.',
  placeholder = 'e.g. Weekly overview — the headline numbers and who needs attention',
  suggestions = [],
  cta = 'Build',
  onSecondary,
  secondaryLabel = 'or add a widget by hand',
}: ReportEmptyStateProps) {
  const [prompt, setPrompt] = useState('')
  const submit = (text: string) => {
    const t = text.trim()
    if (t) onDescribe(t)
    setPrompt('')
  }
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <SparkleGlyph />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{subtitle}</p>

      <div className="mt-7 w-full rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:border-primary/60">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(prompt) }}
          rows={3}
          autoFocus
          placeholder={placeholder}
          className="w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="pl-2 text-xs text-muted-foreground">⌘↵ to build</span>
          <button
            type="button"
            disabled={!prompt.trim()}
            onClick={() => submit(prompt)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <SparkleGlyph className="h-4 w-4" /> {cta}
          </button>
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => submit(s)}
              className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-primary/5"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {onSecondary && (
        <button
          type="button"
          onClick={onSecondary}
          className="mt-8 text-xs text-muted-foreground hover:text-foreground"
        >
          + {secondaryLabel}
        </button>
      )}
    </div>
  )
}

function SparkleGlyph({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2z" />
    </svg>
  )
}
