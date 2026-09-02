import test from 'node:test'
import assert from 'node:assert/strict'
import { makeThrottledRunner, unjudgedNotRun } from './throttled-runner.mjs'

// A harness that stands in for the workflow's sandbox globals. `failing` names the job labels whose
// agent call always returns null — exactly what the harness handed back for the three failed
// dispatches of `verify[severity]:workflows/review.js:1306` in run wf_e10de30a-901.
function harness({ failing = [], budget = { total: 0, remaining: () => Infinity }, batch = 4 } = {}) {
  const notRun = []
  const dispatched = []
  const results = []
  const runThrottled = makeThrottledRunner({
    agent: async (prompt, opts) => {
      dispatched.push(opts.label)
      return failing.some(f => opts.label.endsWith(f)) ? null : { ok: opts.label }
    },
    parallel: async fns => Promise.all(fns.map(f => f())),
    log: () => {},
    markNotRun: (label, note, incomplete) => notRun.push({ label, note, incomplete }),
    batch,
    retryBatch: 2,
    maxRetryRounds: 2,
    budget,
    budgetFloor: 40_000,
  })
  const job = label => ({ prompt: 'p', label, schema: null, effort: 'low', onResult: v => results.push(v) })
  return { runThrottled, notRun, dispatched, results, job }
}

test('a pass where every check answered records nothing — the marker must not fire on healthy runs', async () => {
  const h = harness()
  const left = await h.runThrottled([h.job('verify:a.js:1'), h.job('verify:b.js:2')], 'Verify', 'Verify')
  assert.deepEqual(left, [])
  assert.deepEqual(h.notRun, [])
  assert.equal(h.results.length, 2)
})

test('an unjudged Verify check is retried to exhaustion and then recorded as advisory', async () => {
  const h = harness({ failing: ['verify[severity]:review.js:1306'] })
  const left = await h.runThrottled(
    [h.job('verify:a.js:1'), h.job('verify[severity]:review.js:1306')], 'Verify', 'Verify')

  assert.equal(left.length, 1)
  // initial attempt + two retry rounds, exactly as the live journal recorded
  assert.deepEqual(h.dispatched.filter(l => l.endsWith('review.js:1306')), [
    'verify[severity]:review.js:1306',
    'retry1:verify[severity]:review.js:1306',
    'retry2:verify[severity]:review.js:1306',
  ])
  assert.deepEqual(h.notRun, [{
    label: 'verify-checks-unjudged',
    note: '1 Verify check(s) got no verdict — the findings they were judging were decided on a partial panel, or not decided at all',
    incomplete: false,
  }])
  // The note must not promise an outcome the judge does not produce. It used to say the findings
  // "stay Suspected"; for an escalated finding a lost panel member turned a 2-1 confirmation into a
  // refutation and dropped the finding from the report entirely.
  assert.ok(!/stay Suspected/.test(h.notRun[0].note))
})

// THE REGRESSION. In run wf_e10de30a-901 the check that died three times belonged to the
// coverage-gap verification pass, whose caller discarded runThrottled's return value. The run
// recorded `notRun: []` and reported a finding judged by 2 of 3 panel lenses as if the panel had
// been whole.
test('an unjudged Coverage-verify check reaches notRun under its own label', async () => {
  const h = harness({ failing: ['verify[severity]:review.js:1306'] })
  const left = await h.runThrottled(
    [h.job('verify[code]:review.js:1306'), h.job('verify[exploit]:review.js:1306'), h.job('verify[severity]:review.js:1306')],
    'Coverage-verify', 'Coverage')

  assert.equal(left.length, 1)
  assert.equal(h.results.length, 2, 'the finding was judged by 2 of its 3 panel lenses')
  assert.equal(h.notRun.length, 1, 'the missing third verdict is reported, not silently dropped')
  assert.equal(h.notRun[0].label, 'coverage-verify-checks-unjudged')
  assert.equal(h.notRun[0].incomplete, false, 'an unjudged check is advisory, not INCOMPLETE')
})

test('a caller that reports leftovers itself opts out and gets them back untouched', async () => {
  const h = harness({ failing: ['review:correctness'] })
  const left = await h.runThrottled([h.job('review:correctness'), h.job('review:errors')], 'Review', 'Review', { reportUnjudged: false })
  assert.deepEqual(left.map(j => j.label), ['review:correctness'])
  assert.deepEqual(h.notRun, [])
})

test('a pass stopped before it judged anything is BLOCKING, not advisory', async () => {
  // The budget guard can stop a pass before its first agent is spawned. Advisory there says "some
  // checks are missing" about a pass in which nothing was checked at all — and the verdict then
  // reads as a clean Approve over a set of findings none of which was ever verified.
  const h = harness({ budget: { total: 1_000_000, remaining: () => 1000 }, batch: 1 })
  const left = await h.runThrottled([h.job('verify:a.js:1'), h.job('verify:b.js:2')], 'Verify', 'Verify')
  assert.deepEqual(h.dispatched, [])
  assert.equal(left.length, 2)
  assert.equal(h.notRun.length, 1)
  assert.equal(h.notRun[0].incomplete, true, 'a pass that judged NOTHING downgrades the verdict')
  assert.match(h.notRun[0].note, /entire Verify pass produced no verdict/)
})

test('a gap in an otherwise working pass stays advisory', () => {
  // The symmetric half: a marker that fires on a pass which mostly worked is one people stop
  // reading. Only "nothing was judged" is blocking.
  assert.equal(unjudgedNotRun('Verify', [1], { total: 9 })[0].incomplete, false)
  assert.equal(unjudgedNotRun('Verify', [1, 2, 3], { total: 3 })[0].incomplete, true)
})

test('a job that never returned leaves a placeholder where its verdict would have gone', async () => {
  // Without it the judge cannot tell a 3-lens panel that lost a member from a 2-lens panel.
  const h = harness({ failing: ['verify[severity]:x.js:1'] })
  const seen = []
  const job = { ...h.job('verify[severity]:x.js:1'), onMissing: () => seen.push('severity') }
  await h.runThrottled([job], 'Verify', 'Verify')
  assert.deepEqual(seen, ['severity'], 'the absence is recorded where the vote would have been')
})

test('unjudgedNotRun stays silent on zero and derives a label per pass', () => {
  assert.deepEqual(unjudgedNotRun('Verify', []), [])
  assert.deepEqual(unjudgedNotRun('Verify', 0), [])
  assert.equal(unjudgedNotRun('Verify', 2)[0].label, 'verify-checks-unjudged')
  assert.equal(unjudgedNotRun('Coverage-verify', 1)[0].label, 'coverage-verify-checks-unjudged')
})
