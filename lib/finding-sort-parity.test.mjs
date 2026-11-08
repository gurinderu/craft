// The sorting before publication and the PR comment the Rust CLI posts (cli/crates/craft-review/src/publish/) held to
// this engine's by one shared file, content/parity/sort-cases.json, which cli/crates/craft-review/src/publish/parity.rs
// reads too: each case is a finding and the lines the diff changed (`changed`, null: unknown); the expected side is what
// lib/finding-sort.mjs sorts it into, what lib/memory-contradiction.mjs counts of it, and the body lib/finding-comment.mjs
// writes for it as a defect. A changed rule fails both sides until the file is regenerated:
// `UPDATE_SORT_PARITY=1 npx vitest run lib/finding-sort-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { sortFindings } from './finding-sort.mjs'
import { contradictionRecord } from './memory-contradiction.mjs'
import { findingCommentBody } from './finding-comment.mjs'

const FILE = new URL('../content/parity/sort-cases.json', import.meta.url)
/** @type {Record<string, Array<[number, number]>>} */
const IN_DIFF = { 'src/lib.rs': [[1, 10]] }
const AGAINST = { id: 'D-1', kind: 'decision', why: 'the decision keeps retries' }

/**
 * A finding at `src/lib.rs:<line>`, confirmed and raised by the errors lens unless `extra` says otherwise.
 * @param {number | string} line @param {Record<string, unknown>} [extra]
 */
const at = (line, extra = {}) => ({ severity: 'High', title: 'retry loop never ends', file: 'src/lib.rs', line, why: 'w', fix: 'f', source: 'errors', tier: 'confirmed', ...extra })

/** @type {Array<{ name: string, finding: Record<string, unknown>, changed: Record<string, Array<[number, number]>> | null }>} */
const CASES = [
  { name: 'a confirmed finding on a changed line is a defect', finding: at(3), changed: IN_DIFF },
  { name: 'a suspected one is doubtful', finding: at(3, { tier: 'Suspected' }), changed: IN_DIFF },
  { name: 'the intent lens makes it doubtful', finding: at(3, { source: 'intent' }), changed: IN_DIFF },
  { name: 'each doubt lens is named once', finding: at(3, { source: 'compat', sources: ['compat', 'api-boundary', 'errors'] }), changed: IN_DIFF },
  { name: 'a rollback in the title', finding: at(3, { title: 'Rollback leaves old replicas behind' }), changed: IN_DIFF },
  { name: 'a migration in the reason', finding: at(3, { why: 'the Migrating step drops a column' }), changed: IN_DIFF },
  { name: 'a roll-out and a rolling restart', finding: at(3, { title: 'roll-out order', why: 'a rolling restart races' }), changed: IN_DIFF },
  { name: 'a word inside another word is no sign', finding: at(3, { title: 'unrolled backlog of migrations_x' }), changed: IN_DIFF },
  { name: 'a line outside the diff', finding: at(30), changed: IN_DIFF },
  { name: 'a file the diff did not touch', finding: at(3, { file: 'src/other.rs' }), changed: IN_DIFF },
  { name: 'unknown changed lines apply no outside sign', finding: at(30), changed: null },
  { name: 'no line applies no outside sign', finding: at(0), changed: IN_DIFF },
  { name: 'a line given as text', finding: at('30'), changed: IN_DIFF },
  { name: 'a confirmed contradiction is a defect whatever else says', finding: at(30, { source: 'intent', title: 'breaking change', memoryContradicts: AGAINST }), changed: IN_DIFF },
  { name: 'an unconfirmed contradiction is doubtful, the record first', finding: at(3, { tier: 'suspected', memoryContradicts: AGAINST }), changed: IN_DIFF },
  { name: 'a contradiction of no kind names a record', finding: at(3, { tier: 'suspected', memoryContradicts: { id: 'R-2', why: 'w' } }), changed: IN_DIFF },
  { name: 'a finding a decision set aside is not sorted', finding: at(3, { priorDecision: 'D-9' }), changed: IN_DIFF },
  { name: 'a body with its lens and tool rule', finding: at(3, { severity: 'Medium', title: '  unwrap   on input ', why: ' a\nb ', fix: ' use ? ', source: 'clippy', toolRule: 'clippy::unwrap_used' }), changed: IN_DIFF },
  { name: 'a body whose lens and rule do not fit their lines', finding: at(3, { source: 'intent<x>', toolRule: 'has space' }), changed: IN_DIFF },
  { name: 'a body with no lens and no reason', finding: { severity: 'Low', title: 't', file: 'a.rs', line: 1 }, changed: null },
]

/** What this engine makes of case `c`. @param {typeof CASES[number]} c */
function expected(c) {
  const changed = c.changed ? new Map(Object.entries(c.changed)) : null
  const { defect, doubtful } = sortFindings([c.finding], changed)
  const sorted = defect.length ? 'defect' : doubtful.length ? 'doubtful' : 'none'
  const counted = contradictionRecord([c.finding], changed, () => '', () => sorted === 'defect')
  return {
    sorted, reasons: doubtful[0]?.reasons ?? [],
    contradictions: { count: counted.count, doubtSignsAlone: counted.doubtSignsAlone, inDiffJudged: counted.inDiffJudged, doubtSigns: counted.findings.map(x => x.doubtSigns) },
    body: findingCommentBody(c.finding),
  }
}

test('the sorting and the comment the CLI is held to are the ones this engine makes', () => {
  const cases = CASES.map(c => ({ ...c, expected: expected(c) }))
  if (process.env['UPDATE_SORT_PARITY']) writeFileSync(FILE, `${JSON.stringify({ cases }, null, 2)}\n`)
  const file = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(file.cases, JSON.parse(JSON.stringify(cases)), 'regenerate with UPDATE_SORT_PARITY=1 after a rule change')
})
