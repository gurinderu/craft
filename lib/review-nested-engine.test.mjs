// The review engine routes source files outside every profile to a nested adversarial-review and answers once
// (realm @nick/craft, node #420), executed end to end through the harness.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { NESTED_DIED, NESTED_THREW } from './review-nested-verdict.mjs'

// A Low on the Rust side: unverified, so the run goes through synthesis rather than the no-findings exit.
const RS_LOW = { title: 'a nit', file: 'src/lib.rs', line: 3, severity: 'Low', why: 'w', fix: 'f', ruleId: '' }
const JS_HIGH = { title: 'unchecked input', file: 'web/app.js', line: 7, severity: 'high', description: 'd', fix: 'f', whereChecked: '' }

/** @param {string[]} files @param {Record<string, unknown>} [o] */
const script = (files, o = {}) => ({
  detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc1234' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses: ['correctness'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'correctness', findings: [RS_LOW] },
  dedup: { groups: [] },
  synthesis: '## Verdict\n✅ Approve — clean.\n',
  '*': null,
  ...o,
})

/** @param {string} report */
const verdictLine = report => {
  const lines = report.split('\n')
  const head = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  return String(lines.find((l, i) => i > head && l.trim()))
}
/** @param {{ calls: { label: string, argv?: unknown[] }[] }} run */
const nestedCalls = run => run.calls.filter(c => c.label === 'workflow')

test('a JavaScript-only diff goes wholly to the nested adversarial-review, and its verdict is the one answer', async () => {
  const nested = { verdict: 'Block', confirmed: [JS_HIGH], suspected: [], notRun: [] }
  const run = await runEngine('review', { script: script(['web/app.js', 'README.md'], { workflow: nested }) })
  const [call, ...more] = nestedCalls(run)
  assert.equal(more.length, 0)
  assert.equal(call?.argv?.[0], 'craft:adversarial-review')
  assert.deepEqual(call?.argv?.[1], { diffBase: 'main', files: ['web/app.js'], _via: 'review' })
  assert.ok(!run.calls.some(c => /^lens/.test(c.label)), 'no profile lens runs')
  assert.match(verdictLine(run.report), /^⛔ Block — no language profile covers the diff/)
  assert.match(run.report, /## Files outside every profile — nested adversarial-review\nIts verdict: Block/)
  assert.match(run.report, /- High · `web\/app\.js:7` · unchecked input .*\[adversarial-review\]/)
  const rec = filedRecord(run)
  assert.equal(rec.verdict, 'Block')
  assert.deepEqual(rec.uncoveredFiles, ['README.md'])
  assert.deepEqual([rec.nestedReview.ran, rec.nestedReview.verdict, rec.nestedReview.findings.bySeverity.High], [true, 'Block', 1])
})

test('a Rust and JavaScript diff runs both, and the worse verdict is the answer in the report and the record', async () => {
  const nested = { verdict: 'Block', confirmed: [JS_HIGH], suspected: [], notRun: [] }
  const run = await runEngine('review', { script: script(['src/lib.rs', 'web/app.js'], { workflow: nested }) })
  assert.equal(nestedCalls(run).length, 1)
  const sent = /** @type {{ files?: unknown } | undefined} */ (nestedCalls(run)[0]?.argv?.[1])
  assert.deepEqual(sent?.files, ['web/app.js'])
  assert.ok(run.calls.some(c => /^lens/.test(c.label)), 'the Rust profile still reviews its part')
  assert.match(verdictLine(run.report), /^⛔ Block — clean\. · raised by the nested adversarial-review/)
  assert.doesNotMatch(run.report, /## Not reviewed/)
  const rec = filedRecord(run)
  assert.equal(rec.verdict, 'Block')
  assert.deepEqual(rec.uncoveredFiles, [])
  assert.equal(rec.nestedReview.verdict, 'Block')
  const clean = await runEngine('review', { script: script(['src/lib.rs', 'web/app.js'], { workflow: { verdict: 'Approve', confirmed: [], suspected: [], notRun: [] } }) })
  assert.match(verdictLine(clean.report), /^✅ Approve — clean\.$/)
  assert.equal(filedRecord(clean).verdict, 'Approve')
})

test('a review that is itself nested sends nothing on and names the files outside its profiles as not reviewed', async () => {
  for (const args of [{ _via: 'rust-audit' }, { languages: ['rust'] }]) {
    const run = await runEngine('review', { args, script: script(['src/lib.rs', 'web/app.js'], { lens: { lens: 'correctness', findings: [] }, workflow: { verdict: 'Block', confirmed: [JS_HIGH], suspected: [], notRun: [] } }) })
    assert.equal(nestedCalls(run).length, 0, JSON.stringify(args))
    assert.match(run.report, /## Not reviewed[^\n]*\n- web\/app\.js/)
    const rec = filedRecord(run)
    assert.deepEqual(rec.uncoveredFiles, ['web/app.js'])
    assert.equal(rec.nestedReview, undefined)
    assert.match(rec.verdict, /PARTIAL COVERAGE/)
  }
})

test('a nested engine that dies or cannot launch makes the one verdict INCOMPLETE, its class named', async () => {
  const cases = [[null, NESTED_DIED], [() => { throw new Error('boom') }, NESTED_THREW]]
  for (const [answer, cls] of cases) {
    const run = await runEngine('review', { script: script(['src/lib.rs', 'web/app.js'], { workflow: answer }) })
    const line = verdictLine(run.report)
    assert.match(line, /INCOMPLETE/, line)
    assert.doesNotMatch(line, /✅/, line)
    assert.match(run.report, /It did not run/)
    const rec = filedRecord(run)
    assert.match(rec.verdict, /^INCOMPLETE/)
    assert.ok(rec.notRun.includes(cls), rec.notRun.join('\n'))
    assert.equal(rec.nestedReview.ran, false)
    const only = await runEngine('review', { script: script(['web/app.js'], { workflow: answer }) })
    assert.match(verdictLine(only.report), /^⚠️ INCOMPLETE/)
    assert.ok(filedRecord(only).notRun.includes(cls))
  }
})
