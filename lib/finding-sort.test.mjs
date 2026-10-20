// The sorting before publication (lib/finding-sort.mjs, inlined into src/review.js; realm @nick/craft,
// nodes #270, #277): each sign of doubt alone, none — a defect, the set-aside exclusion, the report section.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readDiffLines } from './diff-lines.mjs'
import { DOUBTFUL_HEADING, doubtReasons, doubtfulSection, postable, sortFindings } from './finding-sort.mjs'

const CHANGED = readDiffLines({ lines: ['HUNK\t+10,5\tb/src/a.rs'] })
/** @param {Record<string, unknown>} [over] */
const f = (over = {}) => ({ severity: 'Medium', title: 'unwrap may panic', why: 'the input can be empty', fix: 'return an error', file: 'src/a.rs', line: 12, tier: 'confirmed', source: 'errors', ...over })

test('a Confirmed finding of another lens, plain words, inside the diff is a defect', () => {
  assert.deepEqual(doubtReasons(f(), CHANGED), [])
  assert.deepEqual(doubtReasons(f({ tier: undefined }), CHANGED), [], 'a finding without a tier is read as Confirmed')
})

test('each sign alone makes a finding doubtful, named', () => {
  assert.deepEqual(doubtReasons(f({ tier: 'suspected' }), CHANGED), ['not confirmed (suspected)'])
  for (const lens of ['compat', 'intent', 'api-boundary']) assert.deepEqual(doubtReasons(f({ source: lens }), CHANGED), [`raised by the ${lens} lens`])
  assert.deepEqual(doubtReasons(f({ source: 'errors', sources: ['errors', 'Compat'] }), CHANGED), ['raised by the compat lens'], 'a merged finding counts every lens')
  for (const words of ['cannot be rolled back', 'a rollback leaves', 'during the rollout', 'a rolling upgrade', 'old replicas still read it', 'the migration drops', 'a breaking change for clients']) {
    assert.deepEqual(doubtReasons(f({ why: words }), CHANGED), ['it speaks of rollback, rollout, old replicas, migration or a breaking change'], words)
  }
  assert.deepEqual(doubtReasons(f({ title: 'Migrate the column' }), CHANGED).length, 1, 'the title counts too')
  assert.deepEqual(doubtReasons(f({ line: 40 }), CHANGED), ['its line is outside the lines the diff changed'])
  assert.deepEqual(doubtReasons(f({ file: 'src/b.rs' }), CHANGED), ['its line is outside the lines the diff changed'])
})

test('words near the signs are not signs; an unknown changed-lines answer does not apply the diff sign', () => {
  assert.deepEqual(doubtReasons(f({ why: 'the immigration form and the rollbar client' }), CHANGED), [])
  assert.deepEqual(doubtReasons(f({ line: 40 }), null), [])
  assert.deepEqual(doubtReasons(f({ line: 0 }), CHANGED), [], 'a finding without a line is not placed')
})

test('signs add up, in order', () => {
  assert.deepEqual(doubtReasons(f({ tier: 'suspected', source: 'compat', why: 'old replicas', line: 99 }), CHANGED), [
    'not confirmed (suspected)', 'raised by the compat lens', 'it speaks of rollback, rollout, old replicas, migration or a breaking change', 'its line is outside the lines the diff changed',
  ])
})

test('sort: defects and doubtful apart; a finding set aside by a decision or covered by a rule is in neither', () => {
  const defect = f()
  const doubtful = f({ source: 'compat' })
  const setAside = f({ priorDecision: 'decision-0123456789', priorKind: 'decision' })
  const covered = f({ source: 'compat', priorDecision: 'rule-0123456789', priorKind: 'rule' })
  const r = sortFindings([defect, doubtful, setAside, covered], CHANGED)
  assert.deepEqual(r.defect, [defect])
  assert.deepEqual(r.doubtful, [{ f: doubtful, reasons: ['raised by the compat lens'] }])
})

test('section: numbered, each with why it is doubtful, then the list as data; nothing — nothing', () => {
  const s = doubtfulSection([{ f: f({ source: 'compat' }), reasons: ['raised by the compat lens'] }, { f: f({ title: 'x', line: 40 }), reasons: ['its line is outside the lines the diff changed'] }], '')
  assert.ok(s.startsWith(`\n\n${DOUBTFUL_HEADING}\nNot posted on the PR: each waits for the reviewer's choice`))
  assert.match(s, /\n1\. Medium · `src\/a\.rs:12` · unwrap may panic · doubtful: raised by the compat lens\n2\. Medium · `src\/a\.rs:40` · x · doubtful: its line is outside the lines the diff changed\n/)
  const data = JSON.parse(String(/```json\n(.*)\n```/.exec(s)?.[1]))
  assert.deepEqual(data[1], { n: 2, severity: 'Medium', title: 'x', file: 'src/a.rs', line: 40, why: 'the input can be empty', fix: 'return an error', source: 'errors', toolRule: '' })
  assert.equal(doubtfulSection([], ''), '')
  assert.match(doubtfulSection([], 'not judged'), /- none · ⚠️ not judged/)
  assert.deepEqual(postable({ title: 't' }, 0), { n: 1, severity: undefined, title: 't', file: undefined, line: 0, why: undefined, fix: undefined, source: '', toolRule: '' })
})
