// Past the match judge's bound, a High a human's decision answers is among the pairs a record can set
// aside, by the same test as the pair ranking (reraisedByRank; realm @nick/craft, nodes #196, #602): it is
// judged before the Medium pairs and set aside, not cut and raised by the title rule.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { matchFindings, MATCH_JUDGE_PAIRS_MAX } from './prior-decision-match.mjs'

/** @param {Record<string, unknown>} over @returns {any} */
const rec = over => ({
  kind: 'question',
  title: 'Nothing guards deletion of a referenced group',
  reason: 'later',
  who: 'a',
  when: '2026-10-01',
  link: '',
  commit: 'abc1234',
  deferred: true,
  supersedes: [],
  line: 40,
  lens: 'safety',
  ...over,
})
/** @param {number} i @param {Record<string, unknown>} over @returns {any} */
const fnd = (i, over) => ({ title: `finding ${i} Nothing guards removal`, line: 100 + i, source: 'safety', why: 'dangling id', ...over })

/** @param {string} prompt @returns {Array<{ pair: number, record: { id: string } }>} */
const pairsOf = prompt => JSON.parse(prompt.match(/^\[\{"pair".*\]$/m)?.[0] ?? '[]')

/** The High's record as the judge saw it, or undefined when its pair was cut. @param {string} decidedBy */
async function judgedHigh(decidedBy) {
  const mediums = Array.from({ length: MATCH_JUDGE_PAIRS_MAX + 2 }, (_, i) => fnd(i, { file: 'src/g.rs', severity: 'Medium' }))
  const high = fnd(0, { file: 'src/h.rs', severity: 'High' })
  const human = rec({ id: 'decision-h', kind: 'decision', deferred: false, decidedBy, scope: 'src/h.rs' })
  /** @type {string[]} */
  let seen = []
  const r = await matchFindings([...mediums, high], [rec({ id: 'question-1', scope: 'src/g.rs' }), human], async p => {
    const pairs = pairsOf(p)
    seen = pairs.map(x => x.record.id)
    return { verdicts: pairs.map(x => ({ pair: x.pair, same: true, why: 'w' })) }
  })
  return { seen, match: r.matchOf(high)?.d.id, refused: r.refused.join('\n') }
}

test('past the bound a High a human decided is judged and matched, ahead of the Medium pairs', async () => {
  const r = await judgedHigh('human')
  assert.equal(r.seen.length, MATCH_JUDGE_PAIRS_MAX)
  assert.ok(r.seen.includes('decision-h'), 'the human-decided High was sent to the judge')
  assert.equal(r.match, 'decision-h')
  assert.doesNotMatch(r.refused, /"finding 0 Nothing guards removal" @ src\/h\.rs/)
})

test('past the bound a High no human decided still goes after the pairs a record can set aside', async () => {
  const r = await judgedHigh('agent')
  assert.ok(!r.seen.includes('decision-h'), 'the agent-decided High was cut')
  assert.equal(r.match, undefined)
  assert.match(r.refused, /"finding 0 Nothing guards removal" @ src\/h\.rs:100 ~ decision-h/)
  assert.match(r.refused, /a High a human's decision answers\) before those its severity raises again/)
})
