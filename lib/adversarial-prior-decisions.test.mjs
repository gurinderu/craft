// Prior decisions through adversarial-review (lib/engine-harness.mjs): the same module as review,
// returned under `rejectedBefore` and `priorDecisionsNotApplied` instead of report sections.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, engineSource } from './engine-harness.mjs'

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

const RECORD = { id: DECISION.id, kind: 'decision', title: DECISION.title, body: DECISION.reason, scope: DECISION.scope, status: 'active', date: DECISION.when, author: DECISION.who, commit: DECISION.commit, links: [DECISION.link] }

test('adversarial-review memory (realm #203): absent → one recall agent, its decisions applied, the source in `memory`', async () => {
  for (const args of [{}, { priorDecisions: '' }, { priorDecisions: null }]) {
    const run = await runEngine('adversarial-review', { args, script: { ...scriptFor('medium'), 'memory-recall': { backend: 'harness', why: 'the default', decisions: [RECORD] } } })
    const recalls = run.calls.filter(c => c.label === 'memory-recall')
    assert.equal(recalls.length, 1)
    assert.match(String(recalls[0]?.prompt), /- src\/pay\.rs[\s\S]*craft:memory skill/)
    const v = run.reportValue
    assert.equal(v.verdict, 'Approve')
    assert.equal(v.rejectedBefore.length, 1)
    assert.deepEqual(v.memory, { source: 'recalled', count: 1, why: 'harness (the default)' })
    assert.equal(v.priorDecisionsAbsent, undefined)
  }
})

test('adversarial-review memory: recall finds nothing or dies → none, named, the result otherwise that of an empty list; passed → no recall', async () => {
  const base = (await runEngine('adversarial-review', { args: { priorDecisions: [], _recalled: true }, script: scriptFor('medium') })).reportValue
  assert.equal(base.verdict, 'Warning')
  assert.deepEqual(base.memory, { source: 'launcher', count: 0, why: '' })
  for (const [recall, why] of /** @type {Array<[unknown, RegExp]>} */ ([[{ backend: 'none', why: 'no backend applies', decisions: [] }, /no backend applies/], [null, /the recall agent died.*findings are raised normally/]])) {
    const run = await runEngine('adversarial-review', { args: {}, script: { ...scriptFor('medium'), 'memory-recall': recall } })
    const { memory, ...same } = run.reportValue
    assert.equal(memory.source, 'none')
    assert.match(memory.why, why)
    assert.deepEqual({ ...same, memory: base.memory }, base)
  }
  const passed = await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: { ...scriptFor('medium'), 'memory-recall': { backend: 'x', why: 'y', decisions: [] } } })
  assert.equal(passed.calls.filter(c => c.label === 'memory-recall').length, 1, 'a passed list adds to the recall, never skips it (realm #218)')
  assert.match(passed.reportValue.memory.why, /^y \(backend x\)/)
  assert.equal(passed.reportValue.memory.passed, 1)
  const bad = (await runEngine('adversarial-review', { args: { priorDecisions: '{nope', _recalled: true }, script: scriptFor('medium') })).reportValue
  const { priorDecisionsNotApplied, ...rest } = bad
  assert.deepEqual(rest, base, 'a malformed value is passed: the result of an empty list plus the refusal')
  assert.match(String(priorDecisionsNotApplied), /arrived as a string/)
})

test('adversarial-review prior decisions: a malformed argument is named on every early return too', async () => {
  const bad = { priorDecisions: '{nope' }
  const scout = (/** @type {string[]} */ changedFiles) => ({ ...scriptFor('medium'), scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles, notes: 'x' } })
  const empty = (await runEngine('adversarial-review', { args: bad, script: scout([]) })).reportValue
  assert.match(String(empty.verdict), /empty diff/)
  assert.match(String(empty.priorDecisionsNotApplied), /arrived as a string/)
  const inert = (await runEngine('adversarial-review', { args: bad, script: { ...scout(['README.md']), 'inert-crosscheck': { ok: true, files: ['README.md'], fileCount: 1 } } })).reportValue
  assert.equal(inert.verdict, 'Approve')
  assert.match(String(inert.priorDecisionsNotApplied), /arrived as a string/)
  const repo = await runEngine('adversarial-review', { args: { ...bad, repo: '/elsewhere' }, script: scriptFor('medium') })
  assert.match(String(repo.report), /repo not supported|does not support/)
  assert.match(String(repo.report), /## Prior decisions not applied[\s\S]*arrived as a string/)
})

test('adversarial-review memory: the count is what was accepted; a refused record is named apart', async () => {
  const run = await runEngine('adversarial-review', { args: {}, script: { ...scriptFor('medium'), 'memory-recall': { backend: 'repo', why: 'w', decisions: [{ id: 'x' }] } } })
  assert.deepEqual(run.reportValue.memory, { source: 'recalled', count: 0, why: 'repo (w)' })
  assert.match(String(run.reportValue.priorDecisionsNotApplied), /lacks an id, a title or a reason/)
})

test('adversarial-review memory: below BUDGET_FLOOR with no priorDecisions the recall is skipped and named; the floor collapse is unchanged', async () => {
  const m = engineSource('adversarial-review').match(/BUDGET_FLOOR\s*=\s*([\d_]+)/)
  const FLOOR = Number(String(m?.[1]).replace(/_/g, ''))
  const run = await runEngine('adversarial-review', { args: {}, script: { ...scriptFor('medium'), 'memory-recall': { backend: 'repo', why: 'w', decisions: [RECORD] } }, budgetTotal: FLOOR })
  assert.ok(!run.calls.some(c => c.label === 'memory-recall'), 'no recall dispatched below the floor')
  assert.ok(!run.calls.some(c => c.threw), 'nothing refused: the collapse is the soft floor, as without the recall')
  assert.match(String(run.reportValue.verdict), /INCOMPLETE/)
  assert.equal(run.reportValue.memory.source, 'none')
  assert.match(run.reportValue.memory.why, /recall did not run — budget below the floor/)
})

test('adversarial-review memory: the source is named on the early returns too', async () => {
  const scout = (/** @type {string[]} */ changedFiles) => ({ ...scriptFor('medium'), scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles, notes: 'x' } })
  const empty = await runEngine('adversarial-review', { args: {}, script: scout([]) })
  assert.equal(empty.reportValue.memory.source, 'none')
  assert.equal(empty.reportValue.memory.why, 'not recalled — nothing to review')
  const inert = await runEngine('adversarial-review', { args: {}, script: { ...scout(['README.md']), 'inert-crosscheck': { ok: true, files: ['README.md'], fileCount: 1 } } })
  assert.equal(inert.reportValue.verdict, 'Approve')
  assert.equal(inert.reportValue.memory.why, 'not recalled — nothing to review')
  assert.ok(!inert.calls.some(c => c.label === 'memory-recall'))
  assert.ok(!empty.calls.some(c => c.label === 'memory-recall'), 'nothing to recall for on an empty diff')
  const given = (await runEngine('adversarial-review', { args: { priorDecisions: [DECISION] }, script: scout([]) })).reportValue
  assert.deepEqual(given.memory, { source: 'none', count: 0, why: 'not recalled — nothing to review', passed: 1 })
})
