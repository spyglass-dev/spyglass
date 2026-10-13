/**
 * The analyst: distri's `<Chat>` with spyglass's report tools.
 *
 * The tools run HERE, in the browser — `create_report`, `add_report_widget`,
 * `explore_data` and the rest read and write the report on screen and query
 * the in-browser engine. The agent definition (agents/spyglass_analyst.md)
 * lives in distri; nothing else does. This is the maps-demo shape: a surface,
 * tools over it, a chat beside it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Chat, useAgent, type ChatInstance, type DistriAnyTool } from '@distri/react'
import { RotateCcw, Sparkles, X } from 'lucide-react'
import { buildReportTools, type ReportHost, type ToolContext } from '@spyglassjs/ui'
import { DEFAULT_FACETS } from '../lib/model'

const AGENT = import.meta.env.VITE_DISTRI_AGENT || 'spyglass_analyst'
const THREAD_KEY = 'spyglass-demo:thread'

export const STARTERS = [
  { label: 'How is the business trending?', prompt: 'How is the business trending this quarter? Build me a report.' },
  { label: 'Which channels convert best?', prompt: 'Which marketing channels convert best, and on which devices?' },
  { label: 'What sells in winter?', prompt: 'What sells in winter compared to summer? Break it down by category.' },
  { label: 'Where do returns come from?', prompt: 'Where do returns come from — which products and categories?' },
]

function threadId(): string {
  const existing = localStorage.getItem(THREAD_KEY)
  if (existing) return existing
  const id = `demo-${Date.now()}`
  localStorage.setItem(THREAD_KEY, id)
  return id
}

export function AnalystPanel({
  host,
  ctx,
  digest,
  describeReport,
  pending,
  onPendingSent,
  onClose,
  onBusyChange,
}: {
  host: ReportHost
  ctx: ToolContext
  digest: string | null
  /** A one-paragraph summary of what is on screen, sent with every turn. */
  describeReport: () => string
  /** A question asked from outside the panel (the empty state, a chip). */
  pending: string | null
  onPendingSent: () => void
  onClose: () => void
  /** The agent is working — the canvas shows it instead of a blank state. */
  onBusyChange?: (busy: boolean) => void
}) {
  const { agent } = useAgent({ agentIdOrDef: AGENT })
  const [thread, setThread] = useState(threadId)
  const [instance, setInstance] = useState<ChatInstance | null>(null)

  const tools = useMemo(
    () => buildReportTools(host, ctx, { defaultFacets: DEFAULT_FACETS }) as unknown as DistriAnyTool[],
    [host, ctx],
  )

  // The model digest and the live report ride as dynamic context on every
  // turn: the agent always knows the cubes and what the reader is looking at.
  const getMetadata = useCallback(
    async () => ({
      dynamic_sections: [
        ...(digest ? [{ key: 'dataset', content: digest }] : []),
        { key: 'on_screen', content: describeReport() },
      ],
    }),
    [digest, describeReport],
  )

  // Send a question asked outside the panel once the chat is live. Deferred
  // and cancellable: under StrictMode the first instance is thrown away, and a
  // message sent on it would stream into nothing.
  useEffect(() => {
    if (!instance || !pending) return
    const timer = setTimeout(() => {
      void instance.sendMessage(pending)
      onPendingSent()
    }, 200)
    return () => clearTimeout(timer)
  }, [instance, pending, onPendingSent])

  const reset = () => {
    const id = `demo-${Date.now()}`
    localStorage.setItem(THREAD_KEY, id)
    setThread(id)
  }

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">Analyst</div>
          <div className="truncate text-[11px] text-muted-foreground">Builds and edits the report with you</div>
        </div>
        <button type="button" onClick={reset} aria-label="New conversation" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close analyst" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {agent && digest ? (
          <Chat
            key={thread}
            threadId={thread}
            agent={agent}
            maxWidth="100%"
            allowBrowserPreview={false}
            enableHistory={false}
            externalTools={tools}
            getMetadata={getMetadata}
            onChatInstanceReady={setInstance}
            onChatStateChange={(state) => onBusyChange?.(state.isStreaming || state.isLoading)}
            starterCommands={STARTERS.map((s) => ({ label: s.label, prompt: s.prompt }))}
            emptyState={{
              eyebrow: 'Ask your data',
              description: 'Ask a question about the store. The analyst builds widgets on the report, and you can click any bar to drill in.',
              promptPlaceholder: 'Ask about revenue, channels, products…',
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {digest ? 'Connecting to the analyst…' : 'Reading the model…'}
          </div>
        )}
      </div>
    </aside>
  )
}
