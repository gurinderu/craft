// Prior decisions through adversarial-review (lib/engine-harness.mjs): the same module as review,
// returned under `rejectedBefore` and `priorDecisionsNotApplied` instead of report sections.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const DECISION = {
  id: 'decision-1', title: 'float arithmetic on amounts', scope: 'src',
  reason: 'amounts are display-only here', who: 'bob', when: '2026-09-30', link: 'https://x/pr/7#c1', commit: 'def5678',
}
/** @param {string} severity */
const finding = severity => ({ title: 'float arithmetic on amounts', file: 'src/pay.rs', line: 4, severity, description: 'd', fix: 'f', whereChecked: '' })

/** @param {string} severity @param {unknown} scope */
const scriptFor = (severity, scope = { unchanged: [DECISION.id], reason: '' }) => ({
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/pay.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [finding(severity)] },
  'coverage-critic': { findings: [] },
  'decision-scope': scope,
  'log-run': { ok: true },
  // `verify:…` for one verifier, `verify[lens]:…` for each member of a critical/high panel.
  '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity } : null),
})

test('adversarial-review prior decisions: an unchanged-scope medium is set aside, marked, out of the verdict', async () => {
  const run = await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: scriptFor('medium') })
  const v = run.reportValue
  assert.equal(v.verdict, 'Approve')
  assert.equal(v.confirmed.length, 0)
  assert.equal(v.rejectedBefore.length, 1)
  assert.match(v.rejectedBefore[0].description, /REJECTED BEFORE: amounts are display-only here — bob, 2026-09-30, https:\/\/x\/pr\/7#c1 \(decision decision-1\)/)
})

test('adversarial-review prior decisions: a high is raised again; a changed scope is raised again', async () => {
  const high = (await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: scriptFor('high') })).reportValue
  assert.equal(high.verdict, 'Block')
  assert.equal(high.rejectedBefore, undefined)
  assert.match(high.confirmed[0].description, /raised again: a Critical\/High finding/)
  const changed = (await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: scriptFor('medium', { unchanged: [], reason: '' }) })).reportValue
  assert.equal(changed.verdict, 'Warning')
  assert.match(changed.confirmed[0].description, /changed since def5678/)
})

test('adversarial-review prior decisions: absent → the same result; malformed → the same result plus the refusal', async () => {
  const base = (await runEngine('adversarial-review', { args: {}, script: scriptFor('medium') })).reportValue
  assert.equal(base.verdict, 'Warning')
  const absent = await runEngine('adversarial-review', { args: { priorDecisions: '' }, script: scriptFor('medium') })
  assert.deepEqual(absent.reportValue, base)
  assert.ok(!absent.calls.some(c => c.label === 'decision-scope'))
  const bad = (await runEngine('adversarial-review', { args: { priorDecisions: '{nope' }, script: scriptFor('medium') })).reportValue
  const { priorDecisionsNotApplied, ...rest } = bad
  assert.deepEqual(rest, base)
  assert.match(String(priorDecisionsNotApplied), /arrived as a string/)
})
