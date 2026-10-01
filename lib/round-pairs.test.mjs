// The "re-review gets cheaper" measurement (realm @nick/craft #97): a pair of consecutive review rounds
// is compared only when nothing but memory differs between them — same head (a frozen diff), same
// engine, and a real cost on both. Anything else is labelled with what confounds it, never averaged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roundPairs, renderRoundPairs } from './round-pairs.mjs'

const cost = (total, cacheRead = total * 10, agents = 10) => ({ output: total / 10, input: 0, cacheRead, cacheWrite: 0, total, agents })
const rec = (round, over = {}) => ({
  schemaVersion: 1, kind: 'workflow', name: 'review', runtime: 'claude-code', craftVersion: '0.22.0', engineRevision: 4,
  project: '/p', branch: 'feat/x', head: 'aaa', round, ts: `2026-10-0${round}T00-00-00Z`,
  lensRounds: [{ round: 1, agents: 20, returned: 20, newFindings: 5 }], verification: { candidates: 10 }, findings: { total: 7 },
  cost: cost(1000 * (3 - round)), ...over,
})

test('a frozen-diff pair on one engine with real cost on both is clean, with its deltas', () => {
  const [p] = roundPairs([rec(1), rec(2)])
  assert.equal(p.status, 'clean')
  assert.deepEqual([p.from.round, p.to.round], [1, 2])
  assert.equal(p.delta.costTotal, 1000 - 2000)
  assert.equal(p.delta.costRatio, 0.5)
})

test('a pair whose diff moved between rounds is not a memory measurement', () => {
  const [p] = roundPairs([rec(1), rec(2, { head: 'bbb' })])
  assert.equal(p.status, 'diff-moved')
  assert.equal(p.delta, null, 'no numbers for a confounded pair')
})

test('a pair across two engines is not one either', () => {
  const [p] = roundPairs([rec(1), rec(2, { engineRevision: 5 })])
  assert.equal(p.status, 'engine-changed')
  assert.equal(p.delta, null)
})

test('a pair without a real cost on both sides says to enrich it', () => {
  const [p] = roundPairs([rec(1, { cost: undefined }), rec(2)])
  assert.equal(p.status, 'cost-missing')
  assert.match(renderRoundPairs([p]), /enrich-cost/)
})

test('only consecutive rounds of one project and branch pair up; partials and other workflows never do', () => {
  const pairs = roundPairs([
    rec(1), rec(3),                                   // a gap: no pair
    rec(1, { branch: 'other' }), rec(2, { project: '/q' }), // different branch / project
    rec(2, { partial: true }),                        // a run that did not finish
    { ...rec(2), name: 'adversarial-review' },        // another workflow
  ])
  assert.deepEqual(pairs, [])
})

test('the engine identity is the engine\'s own revision when it stamped one', () => {
  const [p] = roundPairs([rec(1, { engineRevision: 9, workflowEngineRevision: 4 }), rec(2, { engineRevision: 4 })])
  assert.equal(p.status, 'clean', 'one engine (r4) even though the loggers differed')
})

test('the report states clean pairs with numbers and confounded pairs with the reason only', () => {
  const out = renderRoundPairs(roundPairs([rec(1), rec(2), rec(1, { branch: 'b' }), rec(2, { branch: 'b', head: 'z' })]))
  assert.match(out, /feat\/x[^\n]*round 1 → 2[^\n]*×0\.5/)
  assert.match(out, /\bb\b[^\n]*diff moved/)
  assert.equal(renderRoundPairs([]).includes('No consecutive review rounds'), true)
})

// Through the CLI a reader actually runs, on a real store directory.
test('analyze-runs --round-pairs reports the pairs of a store', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pairs-'))
  try {
    fs.writeFileSync(path.join(store, 'a.json'), JSON.stringify(rec(1)))
    fs.writeFileSync(path.join(store, 'b.json'), JSON.stringify(rec(2)))
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'analyze-runs.mjs')
    const out = execFileSync('node', [script, '--round-pairs', store], { encoding: 'utf8' })
    assert.match(out, /round 1 → 2[^\n]*×0\.5/)
  } finally {
    fs.rmSync(store, { recursive: true, force: true })
  }
})
