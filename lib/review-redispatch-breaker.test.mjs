// What a DEAD verification dispatch costs the window, executed rather than reasoned about.
//
// The measured cost (one large Rust review: 179 agents, 79905 agent-seconds, 6.4h wall clock): 46
// dispatched verifiers returned no verdict at all and held 37050 agent-seconds — 46.4% of the whole
// run. Half of those seconds are `ragent`'s one quiet re-dispatch: a second full harness retry
// ladder, paid inside the same verification window slot, after the first ladder already reported the
// API unreachable. The rationale, the threshold and why the deadline cannot reach this cost live in
// lib/agent-retry.mjs.
//
// These assertions are deliberately CLOCK-FREE. The harness's fake agent answers instantly, so no
// assertion here could measure a duration honestly. The observable is the one that actually converts
// to wall clock: HOW MANY harness dispatches a phase of dead verifiers spends. Every suppressed
// re-dispatch is one whole ladder the window does not hold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { DEATH_STREAK_TO_OPEN } from './agent-retry.mjs'

const finding = (severity, line) => ({
  severity,
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

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }
const liveBatch = ({ prompt }) => ({
  verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })),
})

function scriptFor({ findings, verifyBatch }) {
  return {
    detect: { baseRef: 'main', files: ['src/lib.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['naming'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: ({ callIndex }) => ({ lens: 'naming', findings: callIndex === 0 ? findings : [] }),
    dedup: { groups: [] },
    verify: () => UPHELD,
    'verify-batch': verifyBatch,
    // Synthesis dies on purpose: the mechanical fallback report is the engine's OWN rendering.
    synthesis: null,
    '*': null,
  }
}

// Mediums in one file, which BATCH_SIZE 6 routes into one batch verifier each — eight of them,
// because the tests below need the streak to be reachable BOTH when every entry dies and when only
// every second one does. Four groups would leave the alternating case with two deaths, and a breaker
// that never reset would survive that test unnoticed.
const GROUPS = 8
const MANY = Array.from({ length: GROUPS * 6 }, (_unused, i) => finding('Medium', 10 + i))
const batchLabels = calls => calls.filter(c => /verify-batch/.test(String(c.label))).map(c => String(c.label))

test('review: an outage of dead verifiers stops paying for a second ladder each', async () => {
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: () => null }),
  })
  const labels = batchLabels(calls)
  const firsts = labels.filter(l => !/^retry:/.test(l))
  const retries = labels.filter(l => /^retry:/.test(l))
  assert.equal(firsts.length, GROUPS, 'every group must still be dispatched once — the saving is never a check that is skipped')
  assert.equal(
    retries.length,
    DEATH_STREAK_TO_OPEN - 1,
    'only the deaths that could still be one-off buy a re-dispatch; from the threshold onward the second ladder is not held',
  )
  assert.ok(
    retries.length < firsts.length,
    `an all-dead phase must cost fewer than 2×${GROUPS} dispatches — that ratio is what 46.4% of a measured run was spent on`,
  )
  assert.ok(
    logs.some(l => /NOT re-dispatching/.test(l) && /in a row/.test(l)),
    'and the engine must SAY it stopped re-dispatching, naming the streak — a saving made silently is indistinguishable from a bug',
  )
})

test('review: a suppressed re-dispatch does not make death one decibel quieter', async () => {
  // The three consequences the engine already defends, asserted on findings whose verifier's
  // re-dispatch was suppressed: the unverified tier, the empty denominator, and the not-run list
  // that makes the verdict read INCOMPLETE.
  const run = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: () => null }),
  })
  const { report } = run
  assert.ok(run.logs.some(l => /NOT re-dispatching/.test(l)), 'the run must actually have suppressed something, or this proves nothing')

  const section = s => {
    const i = report.indexOf(`## ${s}`)
    if (i < 0) return ''
    const rest = report.slice(i + 1)
    const j = rest.indexOf('\n## ')
    return j < 0 ? rest : rest.slice(0, j)
  }
  // (1) the tier
  assert.match(section('Unverified'), /src\/lib\.rs:10/, 'a finding nothing checked must still be reported')
  assert.ok(!/src\/lib\.rs:1[0-9]\b/.test(section('Confirmed')), 'and never as Confirmed')
  assert.ok(!/src\/lib\.rs:1[0-9]\b/.test(section('Suspected')), 'nor as Suspected — that tier claims a verifier looked')

  // (2) the denominator
  const record = filedRecord(run)
  assert.ok(record, 'the outgoing record must be recoverable')
  assert.equal(record.verification.candidates, 0, 'nothing was judged, so the refutation denominator is empty')
  assert.equal(record.verification.unverified, MANY.length, 'and every unchecked finding is counted beside it')

  // (3) the not-run list, and the verdict that reads off it
  assert.ok(record.notRun.some(n => /verification of src\/lib\.rs/.test(n)), 'the run must name the verification that never happened')
  assert.match(report, /INCOMPLETE/, 'a verdict standing on unrun verification must not read as a clean approval')
})

test('review: a healthy phase keeps its re-dispatch — the breaker reads deaths, not slowness', async () => {
  // Deaths interleaved with live answers. No streak ever reaches the threshold, so every death is
  // still treated as the one-off it might be. This is the guard against the opposite failure: a
  // cheaper run bought by giving up on work that would have succeeded on the second try.
  let n = 0
  const { calls, logs } = await runEngine('review', {
    args: {},
    script: scriptFor({
      findings: MANY,
      verifyBatch: ctx => {
        n += 1
        return n % 2 === 0 ? null : liveBatch(ctx)
      },
    }),
  })
  const labels = batchLabels(calls)
  const retries = labels.filter(l => /^retry:/.test(l))
  assert.equal(labels.length - retries.length, GROUPS, 'all four groups dispatched')
  assert.equal(retries.length, GROUPS / 2, 'each isolated death still bought its one re-dispatch')
  assert.deepEqual(
    logs.filter(l => /NOT re-dispatching/.test(l)),
    [],
    'nothing may be suppressed while the phase is still answering — a live answer closes the breaker',
  )
})

test('review: a live verifier is never re-dispatched at all', async () => {
  const { calls } = await runEngine('review', {
    args: {},
    script: scriptFor({ findings: MANY, verifyBatch: liveBatch }),
  })
  assert.deepEqual(
    batchLabels(calls).filter(l => /^retry:/.test(l)),
    [],
    'the breaker must not become a reason to dispatch anything twice',
  )
})
