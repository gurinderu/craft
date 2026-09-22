// Budget exhaustion on the engines `review-budget-exhaustion.test.mjs` does NOT reach.
//
// That file drives the ONE road to a verdict under exhaustion that existed in tests: `review`'s lens
// phase collapses to `Approve (INCOMPLETE)`, and its verify phase fails closed. The same defensive
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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, engineSource, filedRecord, CALL_SPEND } from './engine-harness.mjs'

// ================= adversarial-review: the soft floor =================
// A clean happy-path: one material file, one lens that finds nothing, coverage complete. Under an
// unlimited budget this is a bare `Approve`. It is also the calibration for the walled run below —
// the lens that runs here is exactly the one the floor skips there.
const ADV_SCRIPT = {
  scout: { baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['src/lib.rs'], notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [] },
  'coverage-critic': { findings: [] },
  'log-run': { ok: true },
  '*': null,
}

test('adversarial-review: crossing BUDGET_FLOOR collapses the run to INCOMPLETE — WITHOUT a throw', async () => {
  // The control: unlimited budget, the lens runs, nothing is found, coverage is complete → Approve.
  const control = await runEngine('adversarial-review', { args: {}, script: ADV_SCRIPT })
  assert.equal(control.reportValue.verdict, 'Approve', 'the control must be a clean Approve, or the INCOMPLETE below proves nothing')
  assert.ok(control.calls.some(c => String(c.label).startsWith('review:')),
    'the control must actually dispatch the finder lens — the run the floor collapses is this one')
  assert.ok(!control.calls.some(c => c.threw), 'and nothing is refused under an unlimited budget')

  // BUDGET_FLOOR is a private const in the engine (workflows cannot be imported), so it is read from
  // the source rather than hard-coded — a copy of the number here would not move when the engine's
  // does. The wall is a budget EQUAL to the floor: the two Prep dispatches (scout + index-warmup)
  // spend 2×CALL_SPEND, so by the Review phase `remaining()` sits one step below the floor and the
  // throttled runner stops before spawning the first lens. It never actually runs OUT — the four
  // unguarded calls (scout, warmup, coverage-critic, log-run) all fit under the floor — which is the
  // whole distinction being pinned: the collapse is at the floor, not at the harness wall.
  const m = engineSource('adversarial-review').match(/BUDGET_FLOOR\s*=\s*([\d_]+)/)
  assert.ok(m, 'BUDGET_FLOOR must be readable from the engine source — its declaration shape moved')
  const FLOOR = Number(m[1].replace(/_/g, ''))

  const walled = await runEngine('adversarial-review', { args: {}, script: ADV_SCRIPT, budgetTotal: FLOOR })

  // The property that separates this engine from review: it collapses at the floor, so NO dispatch is
  // ever refused. A refused call here would mean the run reached the harness wall — the review
  // mechanism — instead of guarding itself, and the "Budget guard" log below would be a lie.
  assert.ok(!walled.calls.some(c => c.threw),
    'the collapse must happen at the floor, before any dispatch is refused — not at the exhaustion wall')
  assert.ok(walled.logs.some(l => /Budget guard/.test(l)),
    'the budget guard must actually fire and say so — a run that quietly finished would not be guarding anything')

  // The verdict reaches INCOMPLETE, in the returned object AND in the filed record — a run whose only
  // lens never looked covers nothing, and rendering it as a bare Approve is the defect class here.
  assert.match(walled.reportValue.verdict, /^Approve \(INCOMPLETE\)$/,
    'a run whose lenses were all skipped at the floor is INCOMPLETE, never a clean Approve')
  assert.ok(walled.reportValue.notRun.some(n => /finder lens never returned|EVERY finder lens died/.test(n)),
    'and the skipped lens must be named in the not-run list, not silently dropped')
  const record = filedRecord(walled)
  assert.ok(record, 'the run still files its record even after collapsing at the floor')
  assert.equal(record.verdict, 'Approve (INCOMPLETE)', 'the filed verdict must match the returned one')
})

// ================= rust-audit: fail-closed, no soft floor =================
// A minimal COMPLETING control: an empty workspace (no crates, no edges, no unsafe) so the fan-out is
// the workspace-level dimensions plus the single whole-workspace review, and a synthesis that returns
// a body. The dimensions answer null (NOT RUN) — the audit's own verdict is INCOMPLETE — but the RUN
// completes and returns a report, which is all the control has to establish: that the failure below
// is caused by the wall, not by the script.
const RA_SCRIPT = {
  scout: { hasDiff: false, hasUnsafe: false, baseRef: 'main', repoRoot: '/ws', notes: 'x', crates: [], changedCrates: [], edges: [] },
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
  const control = await runEngine('rust-audit', { args: {}, script: RA_SCRIPT })
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
  const err = await runEngine('rust-audit', { args: {}, script: RA_SCRIPT, budgetTotal: wall })
    .then(() => null, e => e)
  assert.ok(err, 'exhaustion after the fan-out starts must abort the run — any rendered report would cover dimensions that never ran')
  assert.match(String(err.message), /budget exhausted/, "and the abort must carry the throw's own reason, not an anonymous death")

  const refused = (err.calls || []).filter(c => c.threw)
  assert.ok(refused.length > 0, 'the exhausted budget must actually refuse dispatches — a stub that cannot run out tests nothing')
  const firstRefused = String(refused[0].label)
  assert.ok(firstRefused !== 'scout' && firstRefused !== 'workflow',
    `the FIRST refusal is a fan-out dimension — the wall this test aims past the fan-out's start (got '${firstRefused}')`)
  // The trail proves the fan-out actually started before the wall: scout, the nested review, and at
  // least one dimension answered.
  const ran = (err.calls || []).filter(c => !c.threw).map(c => c.label)
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
  const refused = (err.calls || []).filter(c => c.threw)
  assert.ok(refused.length > 0 && String(refused[0].label) === 'plan',
    `the FIRST refusal is the Plan dispatch — the phase this test aims the exhaustion at (got '${refused[0]?.label}')`)
})
