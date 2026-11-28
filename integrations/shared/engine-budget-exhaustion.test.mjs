// Budget exhaustion on the engines `review-budget-exhaustion.test.mjs` does NOT reach.
//
// That file drives the ONE road to a verdict under exhaustion that existed in tests: `review`'s lens
// phase collapses to `INCOMPLETE` (never Approve, realm #299), and its verify phase fails closed. The same defensive
// property — a run whose budget died mid-flight must never render as a clean approval — has three
// other carriers, and each reaches it by a DIFFERENT mechanism. Pinning "review does the right
// thing" says nothing about the others: the whole point of the harness is that a property holds on a
// carrier only when it is executed on that carrier.
//
//   adversarial-review — a SOFT floor. It reads `budget.remaining()` and stops SPAWNING agents once
//                        it drops below BUDGET_FLOOR, collapsing to INCOMPLETE with NO throw at all.
//                        This is the one engine that reaches an INCOMPLETE verdict under exhaustion
//                        without a single refused dispatch — the opposite of review's behaviour.
//   rust-audit         — NO soft floor. Exhaustion during the per-dimension fan-out is absorbed by
//                        parallel() (dead dimensions → NOT RUN), but the synthesis that follows is a
//                        direct, unguarded await, so the run fails closed there. Reaching the
//                        INCOMPLETE *verdict* by pure budget is structurally impossible here (below).
//   triage-findings    — no verdict at all: the craft binary drives it, and a refused task or service step is a
//                        dead agent, so the binary is never told the Plan answered and no plan is named.
//   audit              — the same driver as triage-findings: a refused verifier is a dead agent, so the binary
//                        never ends the pass and no verdict is named.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, CALL_SPEND } from './engine-harness.mjs'

/** @typedef {import('./engine-harness.mjs').Call} Call */
/** A run's death as the harness rejects with it: the error, the trail of calls riding on it. @typedef {Error & { calls?: Call[] }} EngineDeath */

// ================= rust-audit: fail-closed, no soft floor =================
// A minimal COMPLETING control: an empty workspace (no crates, no edges, no unsafe) so the fan-out is
// the workspace-level dimensions plus the single whole-workspace review, and a synthesis that returns
// a body. The dimensions but one answer null (NOT RUN) — the audit's own verdict is INCOMPLETE — but the
// RUN completes and returns a report, which is all the control has to establish: that the failure below
// is caused by the wall, not by the script. One live dimension keeps the fan-out from being a round in
// which every agent died, which stops the audit before the synthesis (realm @nick/craft, node #299).
const RA_SCRIPT = {
  scout: { hasDiff: false, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', crates: [], changedCrates: [], edges: [] },
  deps: { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: cargo tree -d' },
  synthesis: 'AUDIT-REPORT-BODY',
  'log-run': { ok: true },
  '*': null,
}

test('rust-audit: budget exhausted after the fan-out starts fails the run closed — no report renders', async () => {
  // rust-audit has NO `budget.remaining()` guard, so it cannot collapse the way adversarial-review
  // does. And it cannot reach the INCOMPLETE *verdict* by pure budget either: a dimension is refused
  // only once `spent` has reached `budgetTotal`, and the synthesis that would render the verdict is
  // dispatched AFTER the fan-out — so if any dimension was refused, the synthesis is refused too. The
  // actual, and only, budget mechanism is fail-closed: the run dies loudly on the unguarded synthesis
  // await, the same shape review's verify-phase test pins on its own carrier.
  // `_recalled`: as if a launcher already recalled — no memory-recall agent (realm #218), so the wall counts only the dispatches pinned here.
  const control = await runEngine('rust-audit', { args: { priorDecisions: [], _recalled: true }, script: RA_SCRIPT })
  assert.match(control.report, /AUDIT-REPORT-BODY/, 'the control must complete and return the synthesis body, or the abort below proves nothing')
  assert.ok(!control.calls.some(c => c.threw), 'and nothing is refused under an unlimited budget')
  const synthAt = control.calls.findIndex(c => c.label === 'synthesis')
  const dimStart = control.calls.findIndex((c, i) => i > 0 && c.label !== 'scout' && c.label !== 'workflow')
  assert.ok(
    dimStart > 0 && synthAt > dimStart + 1,
    `the control must dispatch scout, the nested review, and a fan-out of dimensions before synthesis (dimStart=${dimStart}, synthAt=${synthAt})`,
  )

  // The wall one dispatch into the fan-out: scout, the nested review and the first dimension run; the
  // rest of the fan-out and the synthesis are refused. `spent grows CALL_SPEND per answered call`, so
  // (dimStart + 1) × CALL_SPEND exhausts exactly at the second dimension — after the fan-out started.
  const wall = (dimStart + 1) * CALL_SPEND
  const err = await runEngine('rust-audit', { args: { priorDecisions: [], _recalled: true }, script: RA_SCRIPT, budgetTotal: wall }).then(
    () => null,
    (/** @type {unknown} */ e) => /** @type {EngineDeath} */ (e),
  )
  assert.ok(err, 'exhaustion after the fan-out starts must abort the run — any rendered report would cover dimensions that never ran')
  assert.match(err.message, /budget exhausted/, "and the abort must carry the throw's own reason, not an anonymous death")

  const refused = (err.calls || []).filter((/** @type {import('./engine-harness.mjs').Call} */ c) => c.threw)
  assert.ok(refused.length > 0, 'the exhausted budget must actually refuse dispatches — a stub that cannot run out tests nothing')
  const firstRefused = String(refused[0]?.label)
  assert.ok(
    firstRefused !== 'scout' && firstRefused !== 'workflow',
    `the FIRST refusal is a fan-out dimension — the wall this test aims past the fan-out's start (got '${firstRefused}')`,
  )
  // The trail proves the fan-out actually started before the wall: scout, the nested review, and at
  // least one dimension answered.
  const ran = (err.calls || [])
    .filter((/** @type {import('./engine-harness.mjs').Call} */ c) => !c.threw)
    .map((/** @type {import('./engine-harness.mjs').Call} */ c) => c.label)
  assert.ok(
    ran.includes('scout') && ran.includes('workflow') && ran.length >= 3,
    `scout, the nested review, and at least one dimension must have run before the wall (ran: ${JSON.stringify(ran)})`,
  )
})

// ================= triage-findings: fail-closed, no plan =================
// The completing control: the craft binary (its service steps scripted) hands out a gather task, then the Plan task,
// then names the plan file. triage-findings has no Approve/Block verdict — its output is where the plan is — so the
// property is that a run whose budget died mid-flight never names a plan: the refused dispatches are dead agents and
// dead service steps, so the binary is never told the Plan answered, and the run either ends INCOMPLETE or dies with
// the budget's own throw.
/** A service agent's answer carrying `value` as stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
/** @param {string} id */
const tfTask = id => ({ id, label: id, model: 'opus', kind: id, promptFile: `/r/${id}.md`, schemaFile: `/r/${id}.json`, answerFile: `/r/a/${id}.json` })
const TF_SCRIPT = {
  'step:resolve': { exitCode: 0, stdout: 'root=/p\nbin=/b/craft\n', stderr: '' },
  'step:start': ran({ run: '/r', done: false, tasks: [tfTask('gatherReport')] }),
  gatherReport: 'done',
  'step:submit:1': ran({ run: '/r', done: false, tasks: [tfTask('plan')] }),
  plan: 'done',
  'step:submit:2': ran({ run: '/r', done: true, planFile: '/r/plan.json', recordFile: '/r/record.json', summary: 'PLAN-SUMMARY' }),
  'log-run': { ok: true },
  '*': null,
}

test('triage-findings: budget exhausted at the Plan task fails the run closed — no plan is named', async () => {
  const control = await runEngine('triage-findings', { args: { report: '/store/r.md' }, script: TF_SCRIPT })
  assert.match(
    control.report,
    /The plan is \/r\/plan\.json[\s\S]*PLAN-SUMMARY/,
    'the control must complete and name the plan, or the abort below proves nothing',
  )
  assert.ok(!control.calls.some(c => c.threw), 'and nothing is refused under an unlimited budget')
  const planAt = control.calls.findIndex(c => c.label === 'plan')
  assert.ok(planAt > 0, 'the control must dispatch the Plan task after gathering — the wall below is placed at that index')

  const ended = await runEngine('triage-findings', { args: { report: '/store/r.md' }, script: TF_SCRIPT, budgetTotal: planAt * CALL_SPEND }).then(
    r => ({ report: r.report, calls: r.calls }),
    (/** @type {unknown} */ e) => ({ report: '', calls: /** @type {EngineDeath} */ (e).calls ?? [], died: /** @type {EngineDeath} */ (e).message }),
  )
  assert.ok(!/The plan is /.test(ended.report), `exhaustion at the Plan task must never name a plan: ${ended.report}`)
  const refused = ended.calls.filter((/** @type {import('./engine-harness.mjs').Call} */ c) => c.threw)
  assert.ok(refused[0]?.label === 'plan', `the FIRST refusal is the Plan dispatch — the task this test aims the exhaustion at (got '${refused[0]?.label}')`)
})

// ================= audit: fail-closed, no verdict =================
// The completing control: the craft binary hands out a lens task, then a verifier, then names the report with its
// verdict. A run whose budget died at the verifier never names a verdict: the refused dispatch is a dead agent, so the
// binary is never told the verifier answered, and the run either ends INCOMPLETE or dies with the budget's own throw.
const AU_SCRIPT = {
  'step:resolve': { exitCode: 0, stdout: 'root=/p\nbin=/b/craft\n', stderr: '' },
  'step:start': ran({ run: '/r', done: false, phase: 'lens', tasks: [tfTask('lens')] }),
  lens: 'done',
  'step:submit:1': ran({ run: '/r', done: false, phase: 'verify', tasks: [tfTask('verify')] }),
  verify: 'done',
  'step:submit:2': ran({ run: '/r', done: true, verdict: 'Approve', report: '/r/report.md', recordFile: '/r/record.json' }),
  'log-run': { ok: true },
  '*': null,
}

test('audit: budget exhausted at the verifier fails the run closed — no verdict is named', async () => {
  const control = await runEngine('audit', { args: {}, script: AU_SCRIPT })
  assert.match(control.report, /Verdict: Approve[\s\S]*\/r\/report\.md/, 'the control must complete and name the verdict, or the abort below proves nothing')
  assert.ok(!control.calls.some(c => c.threw), 'and nothing is refused under an unlimited budget')
  const verifyAt = control.calls.findIndex(c => c.label === 'verify')
  assert.ok(verifyAt > 0, 'the control must dispatch the verifier after the lens — the wall below is placed at that index')

  const ended = await runEngine('audit', { args: {}, script: AU_SCRIPT, budgetTotal: verifyAt * CALL_SPEND }).then(
    r => ({ report: r.report, calls: r.calls }),
    (/** @type {unknown} */ e) => ({ report: '', calls: /** @type {EngineDeath} */ (e).calls ?? [], died: /** @type {EngineDeath} */ (e).message }),
  )
  assert.ok(!/Verdict: /.test(ended.report), `exhaustion at the verifier must never name a verdict: ${ended.report}`)
  const refused = ended.calls.filter((/** @type {import('./engine-harness.mjs').Call} */ c) => c.threw)
  assert.ok(refused[0]?.label === 'verify', `the FIRST refusal is the verifier dispatch (got '${refused[0]?.label}')`)
})
