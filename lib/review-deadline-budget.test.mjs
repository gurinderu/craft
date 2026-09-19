// The per-agent deadline is ONE budget shared by the attempts, executed rather than reasoned about.
//
// What changed and why it is worth a test: `ragent` raced each attempt against the full phase
// deadline, so one hanging verification entry could hold its window slot for two deadlines — 2×30min
// for Verify, 2×90min for a lens. The thresholds themselves must not move (they are calibrated
// against a measured live distribution: verifiers to 811s, one legitimate lens to 46 minutes), so
// the arithmetic is what changes.
//
// THESE ASSERTIONS ARE CLOCK-FREE. Nothing here measures a duration — the harness's fake agent
// answers instantly, so no timing assertion could be honest. The observable is the one that converts
// to wall clock: HOW MANY dispatches a hang buys. A tiny `deadlineMs` is passed so the timer fires
// inside a test, and the tiny value is never what is asserted on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const medium = line => ({
  severity: 'Medium',
  title: `t${line}`,
  file: 'src/lib.rs',
  line,
  why: `w${line}`,
  fix: 'fix it',
  blastRadius: '',
  source: 'naming',
  ruleId: '',
  whereChecked: '',
})

function scriptFor(verifyBatch) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? [medium(10)] : [] }),
    dedup: { groups: [] },
    'verify-batch': verifyBatch,
    synthesis: null,
    '*': null,
  }
}

const batchLabels = calls => calls.filter(c => /verify-batch/.test(String(c.label))).map(c => String(c.label))

test('review: a hang spends the deadline BUDGET, so it cannot buy a second wait of the same length', async () => {
  // An agent that never resolves — the exact shape the deadline exists for. Before the budget, the
  // first deadline fire re-dispatched and the second attempt got the FULL deadline again, so one
  // entry's worst case was two of them.
  const { calls, logs } = await runEngine('review', {
    args: { deadlineMs: 5 },
    script: scriptFor(() => new Promise(() => {})),
  })
  const labels = batchLabels(calls)
  assert.deepEqual(
    labels.filter(l => /^retry:/.test(l)),
    [],
    'a deadline fire consumes the budget by definition, so it must buy NO re-dispatch — that is the halving',
  )
  assert.equal(labels.length, 1, 'the check is still dispatched once — the saving is never a check that is skipped')
  assert.ok(
    logs.some(l => /deadline/.test(l) && /budget/.test(l) && /spen[dt]/.test(l)),
    'and the engine must SAY the budget is shared and spent — a saving made silently is indistinguishable from a bug',
  )
})

test('review: a FAST death still buys its one re-dispatch — the budget is not what the retry ladder spends', async () => {
  // The guard against over-correcting. The re-dispatch exists for `agent()` resolving null, which
  // arrives fast and therefore leaves the budget essentially intact; folding that into the same
  // refusal would delete the retry the outage breaker is carefully calibrated around.
  const { calls } = await runEngine('review', {
    args: { deadlineMs: 600000 },
    script: scriptFor(() => null),
  })
  const labels = batchLabels(calls)
  assert.equal(labels.filter(l => !/^retry:/.test(l)).length, 1)
  assert.equal(labels.filter(l => /^retry:/.test(l)).length, 1, 'a fast null must still be re-dispatched once')
})
