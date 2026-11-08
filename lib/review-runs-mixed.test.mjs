// A store that holds review runs of both drivers: the JS engine's `review`, the Rust CLI's under its interim name
// `cli-review`, and the CLI's once it carries the name (`review`, `driver: 'cli'`). The population readers count all
// three; the chain readers keep the JS chain to itself.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './analyze-runs.mjs'
import { indexProjection, isReviewRun, reviewChain, selectPriorRounds } from './run-record.mjs'

/** @param {number} round @param {Record<string, unknown>} [over] @returns {Record<string, unknown>} */
const round = (round, over = {}) => ({
  schemaVersion: 1, kind: 'workflow', name: 'review', runtime: 'claude-code', craftVersion: '1.0.0', engineRevision: 4,
  project: '/p', branch: 'feat/x', head: 'aaa', round, ts: `2026-10-0${round}T00-00-00Z`, verdict: 'Warning',
  findings: { total: 3, bySeverity: { Medium: 3 } }, dimensions: [], filesDigest: 'f', base: 'main', path: '',
  lensRounds: [{ round: 1, agents: 20, returned: 20, newFindings: 5 }], verification: { candidates: 4, confirmed: 3 },
  dirty: false, lensScope: 'full', notRun: [], gate: { status: 'pass' }, strict: false, intentDigest: '7', specDigest: 's',
  runtimeStats: { agents: 10, wallClockMinutes: 5 },
  reReview: round > 1 ? { chained: true, fpComparable: true, priorRound: round - 1, priorHead: 'aaa' } : { chained: false },
  ...over,
})

// Two rounds of each chain on one branch, interleaved in time: JS 1, CLI 1, JS 2, CLI 2 (the CLI's second round under
// the name `review` with its driver, its first under the interim name), and one light JS run on another branch.
const STORE = [
  round(1),
  round(1, { name: 'cli-review', ts: '2026-10-01T01-00-00Z' }),
  round(2),
  round(2, { driver: 'cli', ts: '2026-10-02T01-00-00Z' }),
  round(1, { branch: 'feat/y', head: 'bbb', depth: 'light' }),
]

/** @param {Record<string, unknown>[]} recs @param {(dir: string) => Promise<void>} body */
async function withStore(recs, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mixed-'))
  try {
    recs.forEach((r, i) => fs.writeFileSync(path.join(dir, `${i}.json`), JSON.stringify(r)))
    await body(dir)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('isReviewRun takes either name; reviewChain tells the CLI chain from the JS one', () => {
  assert.deepEqual(['review', 'cli-review', 'rust-audit', undefined].map(name => isReviewRun({ name })), [true, true, false, false])
  assert.equal(isReviewRun(null), false)
  assert.deepEqual([{ name: 'review' }, { name: 'cli-review' }, { name: 'review', driver: 'cli' }, null].map(reviewChain),
    ['js', 'cli', 'cli', 'js'])
})

test('DEPTH counts the review runs of both drivers', async () => {
  await withStore(STORE, async dir => {
    const out = (await run([dir], process.env)).stdout.join('\n')
    assert.match(out, /## DEPTH[^\n]*\n- full: 4 run\(s\), agents\/run 10[^\n]*\n- light: 1 run\(s\)/, out)
  })
})

test('round pairs are made within a chain, never across the JS and the CLI chains', async () => {
  await withStore(STORE, async dir => {
    const out = (await run([dir, '--round-pairs'], process.env)).stdout.join('\n')
    assert.equal((out.match(/round 1 → 2/g) || []).length, 2, out)
    assert.doesNotMatch(out, /engine-changed|engine changed/, 'a JS round is never paired with a CLI one')
    assert.doesNotMatch(out, /folded/, 'a JS and a CLI run of one head and round are two runs, not a resume')
  })
})

test('the JS chain selector skips a CLI run filed under the name review, and the index carries its driver', () => {
  const entries = STORE.map(indexProjection)
  assert.equal(entries[3]?.driver, 'cli')
  assert.equal('driver' in /** @type {object} */ (entries[0]), false, 'a JS run\'s index line is unchanged')
  const prior = selectPriorRounds(entries, { project: '/p', branch: 'feat/x' })
  assert.deepEqual(prior.map(e => e.ts), ['2026-10-02T00-00-00Z', '2026-10-01T00-00-00Z'])
})
