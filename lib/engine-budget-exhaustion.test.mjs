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
//   triage-findings    — NO INCOMPLETE verdict for budget at all. Its Plan agent is the first
//                        unguarded await, so exhaustion fails the run closed before any plan renders.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, CALL_SPEND } from './engine-harness.mjs'

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
  assert.ok(dimStart > 0 && synthAt > dimStart + 1,
    `the control must dispatch scout, the nested review, and a fan-out of dimensions before synthesis (dimStart=${dimStart}, synthAt=${synthAt})`)

  // The wall one dispatch into the fan-out: scout, the nested review and the first dimension run; the
  // rest of the fan-out and the synthesis are refused. `spent grows CALL_SPEND per answered call`, so
  // (dimStart + 1) × CALL_SPEND exhausts exactly at the second dimension — after the fan-out started.
  const wall = (dimStart + 1) * CALL_SPEND
  const err = await runEngine('rust-audit', { args: { priorDecisions: [], _recalled: true }, script: RA_SCRIPT, budgetTotal: wall })
    .then(() => null, e => e)
  assert.ok(err, 'exhaustion after the fan-out starts must abort the run — any rendered report would cover dimensions that never ran')
  assert.match(String(err.message), /budget exhausted/, "and the abort must carry the throw's own reason, not an anonymous death")

  const refused = (err.calls || []).filter((/** @type {import('./engine-harness.mjs').Call} */ c) => c.threw)
  assert.ok(refused.length > 0, 'the exhausted budget must actually refuse dispatches — a stub that cannot run out tests nothing')
  const firstRefused = String(refused[0].label)
  assert.ok(firstRefused !== 'scout' && firstRefused !== 'workflow',
    `the FIRST refusal is a fan-out dimension — the wall this test aims past the fan-out's start (got '${firstRefused}')`)
  // The trail proves the fan-out actually started before the wall: scout, the nested review, and at
  // least one dimension answered.
  const ran = (err.calls || []).filter((/** @type {import('./engine-harness.mjs').Call} */ c) => !c.threw).map((/** @type {import('./engine-harness.mjs').Call} */ c) => c.label)
  assert.ok(ran.includes('scout') && ran.includes('workflow') && ran.length >= 3,
    `scout, the nested review, and at least one dimension must have run before the wall (ran: ${JSON.stringify(ran)})`)
})

// ================= triage-findings: fail-closed, no verdict =================
// The completing control: one report source with no findings, and a Plan agent that returns a plan.
// triage-findings has no Approve/Block/INCOMPLETE verdict — its output is a fix plan — so there is no
// INCOMPLETE verdict for budget to reach. Its Gather/Validate phases run through parallel() (throws
// absorbed → NOT RUN sources / dropped validations); the Plan agent is the first unguarded await, so
// budget exhaustion fails the run closed there before any plan renders. The "> INCOMPLETE TRIAGE"
// banner it CAN print requires the Plan to SURVIVE, so it is a dead-AGENT mechanism, not a budget one.
const TF_SCRIPT = {
  'gather:report': { source: 'rust-audit', findings: [] },
  plan: { plan_markdown: 'PLAN-BODY', summary: 's', ledger: [] },
  'log-run': { ok: true },
  '*': null,
}

test('triage-findings: budget exhausted before the Plan phase fails the run closed — no plan renders', async () => {
  const control = await runEngine('triage-findings', { args: { report: '/store/r.md' }, script: TF_SCRIPT })
  assert.match(control.report, /PLAN-BODY/, 'the control must complete and return the plan, or the abort below proves nothing')
  assert.ok(!control.calls.some(c => c.threw), 'and nothing is refused under an unlimited budget')
  const planAt = control.calls.findIndex(c => c.label === 'plan')
  assert.ok(planAt > 0, 'the control must dispatch the Plan agent after gathering — the wall below is placed at that index')

  // The wall exactly at the Plan dispatch: the gather succeeds and spends, the Plan is refused.
  const err = await runEngine('triage-findings', { args: { report: '/store/r.md' }, script: TF_SCRIPT, budgetTotal: planAt * CALL_SPEND })
    .then(() => null, e => e)
  assert.ok(err, 'exhaustion at the Plan phase must abort the run — any rendered plan would be built on judgements the budget stopped')
  assert.match(String(err.message), /budget exhausted/, "and the abort must carry the throw's own reason, not an anonymous death")
  const refused = (err.calls || []).filter((/** @type {import('./engine-harness.mjs').Call} */ c) => c.threw)
  assert.ok(refused.length > 0 && String(refused[0].label) === 'plan',
    `the FIRST refusal is the Plan dispatch — the phase this test aims the exhaustion at (got '${refused[0]?.label}')`)
})
