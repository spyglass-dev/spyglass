/**
 * Reference queries: worked examples of the model's own use, and lexical
 * retrieval over them.
 *
 * A semantic model tells an agent what members EXIST. It does not tell it which
 * of two plausible measures answers the question — and that is the mistake
 * validation cannot catch, because both members are real. Examples close that
 * gap: they ride on `/meta` beside the cubes, so an example cannot drift from
 * the model it demonstrates, and anti-examples carry the choice that was made
 * wrongly before.
 *
 * Retrieval is lexical (TF-IDF over field-weighted text, with synonym
 * expansion) and exhaustive. The corpus is tens of items, so scoring all of
 * them costs microseconds: no index structure, no staleness, no network hop,
 * and — the part that matters when the agent picks a bad example — you can see
 * WHY something matched. Embedding re-rank is an upgrade behind this same
 * interface, not a prerequisite.
 */
import type { CubeModelMeta, WidgetQuery } from '../querybuilder'
import type { AgentTool } from '../distri'

/** One worked example, authored beside the cube it demonstrates. */
export interface QueryExample {
  id: string
  /** PARAPHRASES, not one canonical phrasing — retrieval quality is mostly a
   *  function of how many real ways of asking are written down. */
  asks: string[]
  /** What one row means ("student × activity"). */
  grain?: string
  /** Prose: what the numbers mean, and the trap in reading them otherwise. */
  means?: string
  query: WidgetQuery
  /** Rendering hints the agent would otherwise guess wrong. */
  widget?: Record<string, unknown>
  /** Cubes this example touches. Defaults to the cube it is declared on. */
  cubes?: string[]
  /** Asserted by the coverage harness, not used at retrieval time. */
  expect?: { min_rows?: number }
}

/**
 * A plausible-but-wrong member choice, with the right one beside it. The
 * expensive mistakes on a mature model are never *unknown member*; they are two
 * real measures that mean different things.
 */
export interface AntiExample {
  ask: string
  wrong: Record<string, unknown>
  right: Record<string, unknown>
  why: string
  cubes?: string[]
}

/** The gap between what a person types and what the model calls things. */
export interface ModelVocabulary {
  /** `{ marks: ['score','grade'] }` — matched in BOTH directions. */
  synonyms?: Record<string, string[]>
  grains?: Record<string, { key: string; cubes?: string[] }>
}

/** One scored candidate, with the reason it scored. */
export interface ExampleMatch {
  id: string
  asks: string[]
  grain?: string
  means?: string
  query: WidgetQuery
  widget?: Record<string, unknown>
  cubes: string[]
  score: number
}

export interface ExampleIndex {
  examples: QueryExample[]
  antiExamples: AntiExample[]
  vocabulary: ModelVocabulary
  /** Cubes in the deployed model — the hard filter (see `buildExampleIndex`). */
  cubeNames: string[]
  /** token → how many documents contain it (for IDF). */
  df: Map<string, number>
  docs: ExampleDoc[]
}

interface ExampleDoc {
  example: QueryExample
  cubes: string[]
  /** field → the token set for that field. */
  fields: Record<FieldName, Set<string>>
  tokens: Set<string>
}

type FieldName = 'asks' | 'identity' | 'means' | 'members'

/** Fields are not equally diagnostic; an `ask` is the question itself. */
const FIELD_WEIGHT: Record<FieldName, number> = {
  asks: 3.0,
  identity: 2.0,
  means: 1.0,
  members: 1.0,
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'of', 'in', 'on', 'for', 'to', 'by', 'and',
  'or', 'with', 'how', 'what', 'which', 'who', 'whom', 'me', 'my', 'our', 'i', 'we', 'us', 'show',
  'give', 'get', 'list', 'do', 'does', 'did', 'it', 'this', 'that', 'per', 'each', 'all', 'any',
  'over', 'from', 'at', 'as', 'their', 'them', 'they', 'much', 'many',
])

/** Crude singularisation. Good enough for a closed vocabulary, and cheap. */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('sses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** Split on non-alphanumerics AND camel/dotted member names, so
 *  `Scores.score_weighted` contributes `score` and `weighted`. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
}

/** Member names mentioned anywhere in a query, as `Cube.member` strings. */
function queryMembers(q: WidgetQuery | undefined): string[] {
  if (!q) return []
  const out = [...(q.measures ?? []), ...(q.dimensions ?? [])]
  for (const f of q.filters ?? []) out.push(f.member)
  for (const td of q.timeDimensions ?? []) out.push(td.dimension)
  return out
}

const cubeOf = (member: string) => member.split('.')[0]

/**
 * Build the retrieval index from `/meta`.
 *
 * The **hard filter** is here rather than at query time: an example is dropped
 * unless every cube it touches exists in this model. A teacher shown a
 * `Platform*` example is sent at cubes they are not permitted to query — a
 * confusing failure at best and a leak of the platform model's shape at worst.
 */
export function buildExampleIndex(meta: CubeModelMeta | undefined): ExampleIndex {
  const cubeNames = (meta?.cubes ?? []).map((c) => c.name)
  const known = new Set(cubeNames)

  const collected: QueryExample[] = []
  for (const cube of meta?.cubes ?? []) {
    for (const ex of cube.examples ?? []) {
      collected.push({ ...ex, cubes: ex.cubes ?? [cube.name] })
    }
  }
  for (const ex of meta?.examples ?? []) collected.push(ex)

  const withCubes = collected.map((ex) => ({
    ex,
    cubes: (ex.cubes && ex.cubes.length ? ex.cubes : queryMembers(ex.query).map(cubeOf)).filter(
      (c, i, arr) => arr.indexOf(c) === i,
    ),
  }))
  const usable = withCubes.filter(({ cubes }) => cubes.length === 0 || cubes.every((c) => known.has(c)))

  const antiExamples = [
    ...(meta?.anti_examples ?? []),
    ...(meta?.cubes ?? []).flatMap((c) =>
      (c.anti_examples ?? []).map((a) => ({ ...a, cubes: a.cubes ?? [c.name] })),
    ),
  ].filter((a) => !a.cubes?.length || a.cubes.every((c) => known.has(c)))

  const docs: ExampleDoc[] = usable.map(({ ex, cubes }) => {
    const fields: Record<FieldName, Set<string>> = {
      asks: new Set(ex.asks.flatMap(tokenize)),
      identity: new Set([...tokenize(ex.id), ...tokenize(ex.grain ?? '')]),
      means: new Set(tokenize(ex.means ?? '')),
      members: new Set([...queryMembers(ex.query), ...cubes].flatMap(tokenize)),
    }
    const tokens = new Set<string>()
    for (const set of Object.values(fields)) for (const t of set) tokens.add(t)
    return { example: { ...ex, cubes }, cubes, fields, tokens }
  })

  const df = new Map<string, number>()
  for (const doc of docs) for (const t of doc.tokens) df.set(t, (df.get(t) ?? 0) + 1)

  return {
    examples: docs.map((d) => d.example),
    antiExamples,
    vocabulary: meta?.vocabulary ?? {},
    cubeNames,
    df,
    docs,
  }
}

/**
 * Expand a question's tokens through the vocabulary, in BOTH directions: a
 * synonym group is an equivalence class, so `marks: [score, grade]` has to fire
 * whether the user typed "marks" or "grades". Returns the expanded token set
 * plus which groups fired, because retrieval you cannot explain is retrieval
 * you cannot fix.
 */
export function expandTokens(
  tokens: string[],
  vocabulary: ModelVocabulary,
): { tokens: Set<string>; hits: string[] } {
  const out = new Set(tokens)
  const hits: string[] = []
  for (const [canonical, group] of Object.entries(vocabulary.synonyms ?? {})) {
    const klass = [canonical, ...group].map((w) => stem(w.toLowerCase()))
    if (klass.some((w) => out.has(w))) {
      hits.push(canonical)
      for (const w of klass) out.add(w)
    }
  }
  return { tokens: out, hits }
}

export interface SearchOptions {
  limit?: number
  /** Cubes already on screen — a small boost, because the open report is context. */
  activeCubes?: string[]
}

/** Score every example against the question. Exhaustive by design. */
export function searchExamples(
  index: ExampleIndex,
  question: string,
  opts: SearchOptions = {},
): { matches: ExampleMatch[]; anti: AntiExample[]; vocabulary_hits: string[] } {
  const { tokens: query, hits } = expandTokens(tokenize(question), index.vocabulary)
  const N = Math.max(1, index.docs.length)
  const idf = (t: string) => Math.log(1 + N / (1 + (index.df.get(t) ?? 0)))
  const active = new Set(opts.activeCubes ?? [])

  const scored = index.docs.map((doc) => {
    let score = 0
    for (const [field, weight] of Object.entries(FIELD_WEIGHT) as [FieldName, number][]) {
      const set = doc.fields[field]
      for (const t of query) if (set.has(t)) score += weight * idf(t)
    }
    if (score > 0 && active.size && doc.cubes.some((c) => active.has(c))) score *= 1.15
    return { doc, score }
  })

  const matches = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3)
    .map(({ doc, score }) => ({
      id: doc.example.id,
      asks: doc.example.asks,
      grain: doc.example.grain,
      means: doc.example.means,
      query: doc.example.query,
      widget: doc.example.widget,
      cubes: doc.cubes,
      score: Math.round(score * 1000) / 1000,
    }))

  // Anti-examples are matched on their ask alone: they are a warning about a
  // wording, and they are cheap enough to return whenever one is relevant.
  const anti = index.antiExamples.filter((a) => {
    const set = new Set(tokenize(a.ask))
    let overlap = 0
    for (const t of query) if (set.has(t)) overlap++
    return overlap >= 2
  })

  return { matches, anti, vocabulary_hits: hits }
}

/**
 * `find_reference_queries` — the FIRST tool a report agent should reach for.
 *
 * The contract is an order: **recognise → verify → build**. This tool, then
 * `explore_data`, then `create_report`. An example is a starting point, not
 * proof that today's data supports it, which is why `explore_data` stays.
 */
export function findReferenceQueriesTool(
  index: ExampleIndex,
  opts: { activeCubes?: () => string[] } = {},
): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'find_reference_queries',
    description:
      'Find worked example queries for a question BEFORE writing one yourself. The model carries verified examples with their meaning, their grain, and the rendering they want; starting from the closest one is faster and more accurate than composing from the member list. Returns `matches` (examples with their queries), `anti` (a plausible-but-wrong member choice with the right one and why — read these, they are the mistakes validation cannot catch), and `vocabulary_hits`. CALL THIS FIRST, before explore_data: recognise, then verify with explore_data, then build.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', description: "The user's question, in their words." },
        limit: { type: 'number', description: 'How many examples to return (default 3).' },
      },
      required: ['question'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { question?: string; limit?: number }
      if (!a.question?.trim()) {
        return [{ part_type: 'data' as const, data: { ok: false, error: 'Provide a `question`.' } }]
      }
      const result = searchExamples(index, a.question, {
        limit: a.limit,
        activeCubes: opts.activeCubes?.(),
      })
      return [
        {
          part_type: 'data' as const,
          data: {
            ok: true,
            ...result,
            ...(result.matches.length
              ? {}
              : {
                  note: 'No example matched. Compose from the model digest and verify with explore_data before building.',
                }),
          },
        },
      ]
    },
  }
}
