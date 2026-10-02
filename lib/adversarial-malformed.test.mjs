// adversarial-review reads model output that the schema is meant to shape but that live agents have
// returned without required fields. A malformed result must degrade the run honestly — never crash it.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const BASE = {
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/lib.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  'coverage-critic': { findings: [] },
  'log-run': { ok: true },
  '*': null,
}

test('adversarial-review: a lens that returns no findings array is not-run, not a crash and not clean', async () => {
  const run = await runEngine('adversarial-review', { args: {}, script: { ...BASE, review: {} } })
  assert.equal(run.reportValue.verdict, 'Approve (INCOMPLETE)')
  assert.ok(run.reportValue.notRun.some((/** @type {string} */ n) => /no findings array/.test(n)), run.reportValue.notRun.join('\n'))
})

test('adversarial-review: a semantic-dedup cluster that is not an array is skipped, not a crash', async () => {
  // More than the engine's DEDUP_THRESHOLD (15) distinct findings, so the semantic tier runs at all.
  const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ')
  const findings = WORDS.map((w, i) => ({ title: `${w} defect`, file: `src/${w}.rs`, line: 1 + i * 100, severity: 'low', description: 'd', fix: 'f', whereChecked: '' }))
  const run = await runEngine('adversarial-review', {
    args: {},
    script: { ...BASE, review: { findings }, 'dedup-semantic': { clusters: [7, 'x', null, [0, 1]] } },
  })
  assert.ok(run.calls.some(c => c.label === 'dedup-semantic'), 'the semantic dedup must actually run, or this pins nothing')
  assert.ok(run.reportValue && typeof run.reportValue.verdict === 'string', 'the run completes with a verdict')
  assert.ok(run.logs.some(l => /Semantic dedup: merged 1 duplicate/.test(l)), 'the well-formed cluster beside the malformed ones still merges')
})

test('adversarial-review: a lens without a findings array counts as dead for all-lenses-dead, the critic and the scout', async () => {
  const run = await runEngine('adversarial-review', { args: {}, script: { ...BASE, review: { findings: 'none' } } })
  assert.equal(run.reportValue.verdict, 'Approve (INCOMPLETE)')
  assert.deepEqual(run.reportValue.scout.deadLenses, ['correctness'])
  assert.ok(run.reportValue.notRun.some((/** @type {string} */ n) => /EVERY finder lens died/.test(n)), run.reportValue.notRun.join('\n'))
  const critic = run.calls.find(c => c.label === 'coverage-critic')
  assert.ok(critic, 'the coverage critic ran')
  assert.match(critic.prompt, /Dead lenses this run[^\n]*"correctness"/)
})

for (const [name, findings] of /** @type {[string, unknown][]} */ ([['{}', {}], ["'none'", 'none']])) {
  test(`adversarial-review: a coverage critic answering findings=${name} is not-run, not a crash and not complete`, async () => {
    const run = await runEngine('adversarial-review', {
      args: {},
      script: { ...BASE, review: { findings: [] }, 'coverage-critic': { findings } },
    })
    assert.equal(run.reportValue.verdict, 'Approve (INCOMPLETE)')
    assert.ok(run.reportValue.notRun.some((/** @type {string} */ n) => /coverage critic answered without a findings array/.test(n)), run.reportValue.notRun.join('\n'))
  })
}

for (const [name, clusters] of /** @type {[string, unknown][]} */ ([['an object', { a: [0, 1] }], ['a number', 3]])) {
  test(`adversarial-review: a semantic-dedup answer whose clusters is ${name} is logged and skipped, not a crash`, async () => {
    const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ')
    const findings = WORDS.map((w, i) => ({ title: `${w} defect`, file: `src/${w}.rs`, line: 1 + i * 100, severity: 'low', description: 'd', fix: 'f', whereChecked: '' }))
    const run = await runEngine('adversarial-review', {
      args: {},
      script: { ...BASE, review: { findings }, 'dedup-semantic': { clusters } },
    })
    assert.ok(run.calls.some(c => c.label === 'dedup-semantic'), 'the semantic dedup must actually run, or this pins nothing')
    assert.ok(run.reportValue && typeof run.reportValue.verdict === 'string', 'the run completes with a verdict')
    assert.ok(run.logs.some(l => /semantic dedup returned clusters that are not an array/.test(l)), run.logs.join('\n'))
  })
}
