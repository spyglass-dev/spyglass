/**
 * Reference-query retrieval.
 *
 * Retrieval that returns *something* always looks like it works, so the
 * assertions here are about the cases where being wrong is silent: the right
 * example ranking above a superficially similar one, a paraphrase reaching an
 * example that shares no words with it, and — the one that matters most — an
 * example from a model the caller cannot query never being offered at all.
 */
import { describe, it, expect } from 'vitest'
import {
  buildExampleIndex,
  expandTokens,
  searchExamples,
  findReferenceQueriesTool,
  tokenize,
  type QueryExample,
} from '../reports/references'
import type { CubeModelMeta } from '../querybuilder'

const gradebook: QueryExample = {
  id: 'gradebook',
  asks: [
    'the gradebook',
    'every student against every activity',
    'show me scores per student per assignment',
  ],
  grain: 'student × activity',
  means: 'Points earned over points possible, per student per activity. Blank is no work, not zero.',
  query: { measures: ['Scores.score_weighted'], dimensions: ['Scores.student_id', 'Scores.activity_id'] },
  widget: { as: 'pivot', format: 'percent' },
  expect: { min_rows: 1 },
}

const overTime: QueryExample = {
  id: 'class-average-over-time',
  asks: ['is the class improving', 'scores over time', 'are they getting better'],
  grain: 'week',
  means: 'Weighted class average by week.',
  query: {
    measures: ['Scores.score_weighted'],
    timeDimensions: [{ dimension: 'Scores.graded_at', granularity: 'week' }],
  },
}

const gradingQueue: QueryExample = {
  id: 'grading-queue',
  asks: ['what is waiting to be graded', 'the grading queue', 'how much marking is left'],
  grain: 'activity',
  means: 'Submissions with no grade yet.',
  query: { measures: ['Submissions.ungraded'], dimensions: ['Submissions.activity_id'] },
}

const META: CubeModelMeta = {
  cubes: [
    {
      name: 'Scores',
      measures: [{ name: 'score_weighted', member: 'Scores.score_weighted' }],
      dimensions: [{ name: 'student_id', member: 'Scores.student_id' }],
      examples: [gradebook, overTime],
      anti_examples: [
        {
          ask: 'average score for the class',
          wrong: { measures: ['Scores.avg_score'] },
          right: { measures: ['Scores.score_weighted'] },
          why: 'avg_score is the mean of per-answer percentages, not a gradebook total.',
        },
      ],
    },
    {
      name: 'Submissions',
      measures: [{ name: 'ungraded', member: 'Submissions.ungraded' }],
      dimensions: [{ name: 'activity_id', member: 'Submissions.activity_id' }],
      examples: [gradingQueue],
    },
  ],
  vocabulary: {
    synonyms: {
      marks: ['score', 'grade', 'result'],
      pupil: ['student', 'learner', 'kid'],
      assignment: ['activity', 'task', 'homework'],
    },
  },
}

const index = buildExampleIndex(META)
const ids = (q: string, limit = 3) => searchExamples(index, q, { limit }).matches.map((m) => m.id)

describe('tokenize', () => {
  it('splits member names into their words and drops stopwords', () => {
    // The cube name is signal too, so `Scores` contributes alongside the member.
    expect(tokenize('Scores.score_weighted')).toEqual(['score', 'score', 'weighted'])
    expect(tokenize('how are all of the students doing')).toEqual(['student', 'doing'])
  })

  it('folds plurals so "scores" reaches "score"', () => {
    expect(tokenize('scores')).toEqual(tokenize('score'))
    expect(tokenize('activities')).toEqual(['activity'])
  })
})

describe('buildExampleIndex', () => {
  it('collects examples from cubes and the model root, defaulting cubes to their host', () => {
    expect(index.examples.map((e) => e.id).sort()).toEqual([
      'class-average-over-time',
      'gradebook',
      'grading-queue',
    ])
    expect(index.examples.find((e) => e.id === 'gradebook')!.cubes).toEqual(['Scores'])
  })

  it('takes cross-cube examples from the model root', () => {
    const withRoot = buildExampleIndex({
      ...META,
      examples: [
        {
          id: 'worst-classes',
          asks: ['where is scoring worst'],
          cubes: ['Scores', 'Submissions'],
          query: { measures: ['Scores.score_weighted'] },
        },
      ],
    })
    expect(withRoot.examples.map((e) => e.id)).toContain('worst-classes')
  })

  /**
   * The hard filter. A teacher offered a `Platform*` example is sent at cubes
   * they are not permitted to query — and told the shape of a model they
   * cannot see.
   */
  it('drops examples whose cubes are not in THIS model', () => {
    const teacherModel = buildExampleIndex({
      cubes: [
        {
          name: 'Scores',
          measures: [],
          dimensions: [],
          examples: [gradebook],
        },
      ],
      examples: [
        {
          id: 'platform-growth',
          asks: ['how is the platform growing'],
          cubes: ['PlatformWorkspaces'],
          query: { measures: ['PlatformWorkspaces.count'] },
        },
      ],
    })
    expect(teacherModel.examples.map((e) => e.id)).toEqual(['gradebook'])
    expect(searchExamples(teacherModel, 'how is the platform growing').matches).toEqual([])
  })

  it('is empty and harmless when the model carries no examples', () => {
    const bare = buildExampleIndex({ cubes: [{ name: 'A', measures: [], dimensions: [] }] })
    expect(bare.examples).toEqual([])
    expect(searchExamples(bare, 'anything').matches).toEqual([])
    expect(buildExampleIndex(undefined).examples).toEqual([])
  })
})

describe('searchExamples — ranking', () => {
  it('finds the example that was asked for, by its own words', () => {
    expect(ids('show me the gradebook')[0]).toBe('gradebook')
    expect(ids('what is waiting to be graded')[0]).toBe('grading-queue')
    expect(ids('is the class improving')[0]).toBe('class-average-over-time')
  })

  it('reaches a paraphrase through the vocabulary, not through shared words', () => {
    // "marks per pupil per assignment" shares almost nothing with any ask.
    const result = searchExamples(index, 'marks for each pupil on each assignment')
    expect(result.matches[0].id).toBe('gradebook')
    expect(result.vocabulary_hits).toEqual(expect.arrayContaining(['marks', 'pupil', 'assignment']))
  })

  it('matches a user who names the measure', () => {
    expect(ids('score_weighted by student')[0]).toBe('gradebook')
  })

  it('returns nothing rather than a bad guess when no word matches', () => {
    expect(searchExamples(index, 'zzzz qqqq').matches).toEqual([])
  })

  it('honours the limit and ranks descending', () => {
    const matches = searchExamples(index, 'scores per student over time', { limit: 2 }).matches
    expect(matches).toHaveLength(2)
    expect(matches[0].score).toBeGreaterThanOrEqual(matches[1].score)
  })

  it('boosts an example whose cubes are already on screen', () => {
    const plain = searchExamples(index, 'scores over time').matches[0]
    const boosted = searchExamples(index, 'scores over time', { activeCubes: ['Scores'] }).matches[0]
    expect(boosted.id).toBe(plain.id)
    expect(boosted.score).toBeGreaterThan(plain.score)
  })

  it('carries the rendering hint, so the agent does not guess the widget', () => {
    expect(ids('the gradebook')[0]).toBe('gradebook')
    expect(searchExamples(index, 'the gradebook').matches[0].widget).toEqual({
      as: 'pivot',
      format: 'percent',
    })
  })
})

describe('anti-examples — the mistake validation cannot catch', () => {
  it('surfaces the wrong/right pair for the wording that triggers it', () => {
    const { anti } = searchExamples(index, 'what is the average score for the class')
    expect(anti).toHaveLength(1)
    expect(anti[0].right).toEqual({ measures: ['Scores.score_weighted'] })
    expect(anti[0].why).toContain('per-answer')
  })

  it('stays quiet for an unrelated question', () => {
    expect(searchExamples(index, 'the grading queue').anti).toEqual([])
  })
})

describe('expandTokens', () => {
  it('expands in BOTH directions — a group is an equivalence class', () => {
    // Tokens arrive stemmed (`tokenize` runs first), and the group is stemmed
    // to match — otherwise "marks" and "mark" would be different words.
    const fromCanonical = expandTokens(tokenize('marks'), META.vocabulary!)
    const fromMember = expandTokens(tokenize('grades'), META.vocabulary!)
    expect(fromCanonical.tokens.has('score')).toBe(true)
    expect(fromMember.tokens.has('mark')).toBe(true)
    expect(fromMember.hits).toEqual(['marks'])
  })

  it('fires no group when nothing matches', () => {
    expect(expandTokens(tokenize('banana'), META.vocabulary!).hits).toEqual([])
  })
})

describe('find_reference_queries tool', () => {
  const call = async (input: unknown) =>
    (await findReferenceQueriesTool(index).handler(input))[0].data as Record<string, unknown>

  it('returns matches, anti-examples and which synonyms fired', async () => {
    const out = await call({ question: 'marks per pupil per assignment' })
    expect(out.ok).toBe(true)
    expect((out.matches as Array<{ id: string }>)[0].id).toBe('gradebook')
    expect(out.vocabulary_hits).toBeInstanceOf(Array)
  })

  it('says what to do instead when nothing matches, rather than returning empty', async () => {
    const out = await call({ question: 'zzzz qqqq' })
    expect(out.matches).toEqual([])
    expect(String(out.note)).toContain('explore_data')
  })

  it('refuses an empty question', async () => {
    expect(await call({ question: '  ' })).toEqual({ ok: false, error: 'Provide a `question`.' })
  })

  it('passes the open report cubes through as ranking context', async () => {
    const tool = findReferenceQueriesTool(index, { activeCubes: () => ['Submissions'] })
    const out = (await tool.handler({ question: 'grading', limit: 1 }))[0].data as {
      matches: Array<{ id: string }>
    }
    expect(out.matches[0].id).toBe('grading-queue')
  })
})
