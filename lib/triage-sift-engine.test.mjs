// triage-findings' sift before validation, end to end in the engine harness (realm @nick/craft, node #305):
// what project memory answers leaves for the ledger without a validator, a Critical match and a changed
// scope are raised again (node #309), a finding going against a record is a conflict for a human, passed
// records are used (node #306), repeats in the batch collapse, and the validator's noise classes settle
// "not this PR's" as a deferral with an issue (node #303).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

const DECISION = {
  id: 'decision-bc2a4e82f6', title: 'float arithmetic on amounts', scope: 'src',
  reason: 'amounts are display-only here', who: 'bob', when: '2026-09-30', link: 'https://x/pr/7#c1', commit: 'def5678',
}
const RECORD = { id: DECISION.id, kind: 'decision', title: DECISION.title, body: DECISION.reason, scope: DECISION.scope, status: 'active', date: DECISION.when, author: DECISION.who, commit: DECISION.commit, links: [DECISION.link] }
/** @param {string} severity @param {string} [title] @param {string} [location] */
const finding = (severity, title = 'float arithmetic on amounts', location = 'src/pay.rs:4') => ({ severity, title, location, detail: 'd', proposed_fix: '', thread_id: '' })
/** @param {{ title: string, location: string }} f */
const idOf = f => `github-pr::${f.location}::${f.title}`
// The plan agent as a faithful one: its ledger is every validation it was handed, the sifted rows left to the engine.
/** @param {{ prompt: string }} call */
const PLAN = ({ prompt }) => {
  const verdicts = /ALL VERDICTS[^\n]*\n([\s\S]*?)\n\nSETTLED BEFORE VALIDATION/.exec(prompt)?.[1] ?? '[]'
  const ledger = JSON.parse(verdicts).map((/** @type {any} */ v) => ({ stable_id: v.stable_id, verdict: v.verdict, reason: v.reason }))
  return { plan_markdown: 'BODY', summary: 'S', ledger }
}
/** @param {string} id @param {Record<string, unknown>} [over] */
const validation = (id, over = {}) => ({ stable_id: id, verdict: 'accept', reason: 'real', fix_pointer: 'rust-errors: x', premise_checked: '', noise_class: 0, severity: 'Medium', ...over })

/**
 * @param {unknown[]} findings @param {Record<string, unknown>} [script] @param {Record<string, unknown>} [args]
 */
const run = (findings, script = {}, args = {}) => runEngine('triage-findings', {
  args: { pr: '9', ...args },
  script: {
    'log-run': { ok: true },
    'gather:pr': { source: 'github-pr', findings },
    'memory-recall': { backend: 'harness', why: 'the default', decisions: [RECORD] },
    'decision-scope': { unchanged: [DECISION.id], missing: [], reason: '' },
    validate: (/** @type {{ prompt: string }} */ { prompt }) => validation(/stable_id MUST be exactly: (.+)/.exec(prompt)?.[1] ?? '?'),
    plan: PLAN,
    ...script,
  },
})

/** @param {any} r @param {string} id */
const row = (r, id) => r.reportValue.ledger.find((/** @type {any} */ e) => e.stable_id === id)
/** @param {any} r */
const validated = r => r.calls.filter((/** @type {any} */ c) => c.label.startsWith('validate:'))

test('a finding an active decision answers is rejected before, with no validator, and the ledger names who, when and where', async () => {
  const f = finding('Medium')
  const r = await run([f])
  assert.equal(validated(r).length, 0)
  const e = row(r, idOf(f))
  assert.equal(e.verdict, 'reject')
  assert.match(e.reason, /^SIFTED BEFORE VALIDATION — REJECTED BEFORE: amounts are display-only here — bob, 2026-09-30, https:\/\/x\/pr\/7#c1 \(decision decision-bc2a4e82f6\)/)
  const recall = r.calls.find((/** @type {any} */ c) => c.label === 'memory-recall')
  assert.match(String(recall?.prompt), /- src\/pay\.rs/)
  const rec = filedRecord(r)
  assert.equal(rec.triage.reject, 1)
  assert.equal(rec.triage.validated, 0)
  assert.equal(rec.triage.sifted.rejectedBefore, 1)
  assert.equal(rec.memory.source, 'recalled')
  assert.match(r.reportValue.memory, /^memory: recalled 1/)
})

test('a Critical finding a decision answers is raised again and judged; so is one whose scope changed since the commit', async () => {
  const f = finding('Critical')
  const r = await run([f])
  assert.equal(validated(r).length, 1)
  assert.match(validated(r)[0].prompt, /- project memory: Rejected before \(decision decision-bc2a4e82f6, bob, 2026-09-30\) — raised again: a Critical\/High finding is never set aside/)
  assert.equal(row(r, idOf(f)).verdict, 'accept')
  assert.equal(filedRecord(r).triage.sifted.reraised, 1)

  const changed = await run([finding('Medium')], { 'decision-scope': { unchanged: [], missing: [], reason: '' } })
  assert.equal(validated(changed).length, 1)
  assert.match(validated(changed)[0].prompt, /changed since def5678/)
})

test('a finding the judge shows going against a record is a conflict for a human, not validated', async () => {
  const f = finding('High')
  const r = await run([f], { 'decision-match': { verdicts: [{ pair: 0, same: false, violates: true, why: 'the code drops the display-only guard' }] } })
  assert.equal(validated(r).length, 0)
  const e = row(r, idOf(f))
  assert.equal(e.verdict, 'conflict')
  assert.match(e.reason, /goes against decision decision-bc2a4e82f6 in project memory \(the code drops the display-only guard\); a human decides/)
  assert.equal(filedRecord(r).triage.sifted.conflict, 1)
})

test('passed priorDecisions are used even when the recall finds nothing', async () => {
  const f = finding('Low')
  const r = await run([f], { 'memory-recall': { backend: 'none', why: 'no backend applies', decisions: [] } }, { priorDecisions: [DECISION] })
  assert.equal(validated(r).length, 0)
  assert.equal(row(r, idOf(f)).verdict, 'reject')
  assert.equal(filedRecord(r).memory.passed, 1)
  const without = await run([f], { 'memory-recall': { backend: 'none', why: 'no backend applies', decisions: [] } })
  assert.equal(validated(without).length, 1, 'without the passed record nothing sets the finding aside')
})

test('a finding the validator shows already at the base is deferred with an issue action; unchecked, a human decides', async () => {
  const f = finding('Medium', 'unbounded queue growth', 'lib/q.rs:3')
  const atBase = { base: 'abc1234' }
  const pre = { validate: validation(idOf(f), { verdict: 'defer', reason: 'stands at main', noise_class: 1, premise_checked: 'git show abc1234:lib/q.rs:3' }) }
  const r = await run([f], pre, atBase)
  const e = row(r, idOf(f))
  assert.deepEqual([e.verdict, e.action], ['defer', 'issue'])
  assert.equal(r.reportValue.issues.length, 1)
  assert.equal(r.reportValue.issues[0].title, 'unbounded queue growth')
  assert.match(r.reportValue.issues[0].body, /stands at main \(checked at git show abc1234:lib\/q\.rs:3\)/)
  assert.equal(filedRecord(r).triage.issues, 1)
  assert.match(validated(r)[0].prompt, /Check it AT THE BASE, not by the reviewer's word/)
  assert.match(validated(r)[0].prompt, /`git show abc1234:<path>`/, 'the validator is told the exact base to cite')

  // A ref the validator picked itself (node #309): HEAD is the PR's own code, and shows nothing.
  for (const premise of ['', 'git show HEAD:lib/q.rs', 'git show main:lib/q.rs', 'git merge-base main HEAD']) {
    const unchecked = await run([f], { validate: validation(idOf(f), { verdict: 'defer', reason: 'pre-existing', noise_class: 1, premise_checked: premise }) }, atBase)
    assert.equal(row(unchecked, idOf(f)).verdict, 'needs-decision', premise)
    assert.equal(row(unchecked, idOf(f)).action, undefined)
    assert.equal(unchecked.reportValue.issues, undefined)
  }
  const noBase = await run([f], pre)
  assert.equal(row(noBase, idOf(f)).verdict, 'needs-decision', 'no base given: class 1 is never checked')
  assert.equal(noBase.reportValue.issues, undefined)
  assert.match(validated(noBase)[0].prompt, /no base was given/)

  const notReal = await run([f], { validate: validation(idOf(f), { verdict: 'reject', reason: 'no growth: bounded by cap', noise_class: 1, premise_checked: 'git show abc:lib/q.rs' }) })
  assert.deepEqual([row(notReal, idOf(f)).verdict, row(notReal, idOf(f)).action], ['reject', undefined])
  assert.equal(notReal.reportValue.issues, undefined)

  const rollout = await run([f], { validate: validation(idOf(f), { noise_class: 5 }) })
  assert.equal(row(rollout, idOf(f)).verdict, 'needs-decision')
})

test('a repeat in the batch collapses onto the most severe copy, which alone is validated', async () => {
  const low = finding('Low', 'unbounded queue growth here', 'lib/q.rs:3')
  const high = finding('High', 'queue growth unbounded here', 'lib/q.rs:5')
  const r = await run([low, high])
  assert.equal(validated(r).length, 1)
  assert.match(validated(r)[0].prompt, /- severity: High/)
  const e = row(r, idOf(low))
  assert.equal(e.verdict, 'reject')
  assert.match(e.reason, new RegExp(`repeats ${idOf(high).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} in this batch`))
  assert.equal(filedRecord(r).triage.sifted.repeats, 1)
})

test('a repeat row names its twin by a field, so the review ledger takes the twin\'s disposition, not the repeat\'s reject (node #312)', async () => {
  const low = finding('Low', 'unbounded queue growth here', 'lib/q.rs:3')
  const high = finding('High', 'queue growth unbounded here', 'lib/q.rs:5')
  const r = await run([low, high])
  assert.equal(row(r, idOf(low)).repeat_of, idOf(high), 'the plan agent drops the field; the engine restores it')
  assert.equal(row(r, idOf(high)).repeat_of, undefined)
  const forgot = await run([low, high], { plan: () => ({ plan_markdown: 'BODY', summary: 'S', ledger: [] }) })
  assert.equal(row(forgot, idOf(low)).repeat_of, idOf(high), 'a row the plan dropped comes back with it')})

test('a re-run never carries a sifted row: a finding the sift now raises again, and a former repeat, reach a validator', async () => {
  const f = finding('Medium')
  const first = await run([f])
  assert.equal(validated(first).length, 0)
  assert.equal(row(first, idOf(f)).sifted, true, 'a sifted row says so by a field')
  const again = await run([f], { 'decision-scope': { unchanged: [], missing: [], reason: '' } }, { priorLedger: first.reportValue.ledger })
  assert.equal(validated(again).length, 1, 'the scope changed since the commit, so the finding is judged, not carried')
  assert.equal(row(again, idOf(f)).verdict, 'accept')
  assert.equal(row(again, idOf(f)).sifted, undefined)

  const low = finding('Low', 'unbounded queue growth here', 'lib/q.rs:3')
  const twice = await run([low, finding('High', 'queue growth unbounded here', 'lib/q.rs:5')])
  assert.equal(row(twice, idOf(low)).sifted, true)
  const alone = await run([low], {}, { priorLedger: twice.reportValue.ledger })
  assert.equal(validated(alone).length, 1, 'its copy is gone, so the former repeat is judged')
})
