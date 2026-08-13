/**
 * WidgetPromptDialog — add or change ONE widget without leaving the report.
 *
 * Both flows are the same gesture: describe it in words, the host hands the
 * text to its agent, the widget appears or changes in place. Editing takes the
 * widget's index so the agent replaces that one rather than rebuilding the
 * report — which is the whole reason `edit_report_widget` exists.
 *
 * Deliberately dependency-free: a plain overlay rather than a dialog library,
 * because `@spyglass/ui` is embedded in hosts that already ship their own and
 * two dialog implementations in one tree is how focus handling breaks. Styling
 * is Tailwind design tokens, like the rest of the library.
 */
import { useEffect, useRef, useState } from 'react'

export type WidgetPromptState =
  | { mode: 'add' }
  /** `index` is the widget's position in the report — what the edit tool takes. */
  | { mode: 'edit'; index: number; label?: string }
  | null

export interface WidgetPromptDialogProps {
  state: WidgetPromptState
  onOpenChange: (open: boolean) => void
  /** The host routes this to its agent, along with the state it was given. */
  onDescribe: (text: string, state: NonNullable<WidgetPromptState>) => void
  addSuggestions?: string[]
  editSuggestions?: string[]
  addTitle?: string
  editTitle?: string
  /**
   * An escape hatch offered below the prompt — e.g. "edit the query directly",
   * opening a manual query builder. Demoted, not removed: describing it is the
   * default because it is what most people want, but someone who knows exactly
   * which member they need should not have to spell it out in a sentence.
   */
  secondaryAction?: { label: string; onClick: (state: NonNullable<WidgetPromptState>) => void }
}

export function WidgetPromptDialog({
  state,
  onOpenChange,
  onDescribe,
  addSuggestions = [],
  editSuggestions = [],
  addTitle = 'Add a widget',
  editTitle = 'Change this widget',
  secondaryAction,
}: WidgetPromptDialogProps) {
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const open = state !== null
  const editing = state?.mode === 'edit'

  useEffect(() => {
    if (open) {
      setPrompt('')
      // Open with the caret already in the box: the dialog exists to be typed in.
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (!state) return null

  const send = (text: string) => {
    const t = text.trim()
    if (!t) return
    setPrompt('')
    onOpenChange(false)
    onDescribe(t, state)
  }

  const suggestions = editing ? editSuggestions : addSuggestions

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? editTitle : addTitle}
        className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-lg"
      >
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {editing ? editTitle : addTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {editing
            ? `Describe the change${state.label ? ` to “${state.label}”` : ''} — it is re-made in place.`
            : 'Describe what you want to see. It is appended to this report.'}
        </p>

        <div className="mt-4 rounded-xl border border-border bg-background p-2 focus-within:border-primary/60">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(prompt)
            }}
            rows={3}
            placeholder={
              editing ? 'e.g. make it a bar chart, grouped by week' : 'e.g. average score by group, as a table'
            }
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between px-1 pb-0.5">
            <span className="pl-1 text-xs text-muted-foreground">⌘↵ to send</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!prompt.trim()}
                onClick={() => send(prompt)}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {editing ? 'Change it' : 'Add it'}
              </button>
            </div>
          </div>
        </div>

        {secondaryAction && (
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
              secondaryAction.onClick(state)
            }}
            className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {secondaryAction.label}
          </button>
        )}

        {suggestions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-primary/5"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
