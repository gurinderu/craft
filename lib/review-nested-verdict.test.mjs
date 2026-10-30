// Unit tests of lib/review-nested-verdict.mjs and the pure parts of lib/review-nested.mjs: the nested
// adversarial-review's answer read into one shape, the worse of two verdicts, the section and the record field.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readNested, combinedVerdict, raiseVerdictLine, nestedSection, nestedRecord, NESTED_DIED, NESTED_THREW, NESTED_PARTIAL } from './review-nested-verdict.mjs'
import { nestingBarred, nestedLaunchArgs } from './review-nested.mjs'

const F = ['web/app.js']
const MED = { title: 't', file: 'web/app.js', line: 2, severity: 'medium', description: 'd', fix: 'f' }

test('an answer without a verdict is a run that did not happen, its class by cause', () => {
  assert.deepEqual([readNested(null, F).ran, readNested(null, F).own], [false, [NESTED_DIED]])
  assert.deepEqual(readNested('## refused', F).own, [NESTED_DIED])
  assert.equal(readNested('## refused', F).why, 'its answer carried no verdict')
  assert.deepEqual(readNested(null, F, 'boom').own, [NESTED_THREW])
  assert.match(readNested(null, F, 'boom').why, /threw: boom/)
})

test('a run reads its verdict word, findings and notRun; an INCOMPLETE one adds its class', () => {
  const r = readNested({ verdict: 'Warning', confirmed: [MED], suspected: 'x', notRun: ['a'] }, F)
  assert.deepEqual([r.ran, r.core, r.confirmed.length, r.suspected, r.notRun, r.own], [true, 'Warning', 1, [], ['a'], []])
  assert.deepEqual(readNested({ verdict: 'Block (INCOMPLETE)' }, F).own, [NESTED_PARTIAL])
  assert.equal(readNested({ verdict: 'INCOMPLETE (empty diff)' }, F).core, 'INCOMPLETE')
  assert.equal(readNested({ verdict: 'Approve' }, F).core, 'Approve')
})

test('the combined verdict is the worse of the two, markers kept, and never green over a nested run that did not happen', () => {
  const block = readNested({ verdict: 'Block' }, F)
  assert.equal(combinedVerdict('Approve', block), 'Block')
  assert.equal(combinedVerdict('Warning (PARTIAL COVERAGE)', block), 'Block (PARTIAL COVERAGE)')
  assert.equal(combinedVerdict('INCOMPLETE', block), 'Block (INCOMPLETE)')
  assert.equal(combinedVerdict('Block', readNested({ verdict: 'Warning' }, F)), 'Block')
  assert.equal(combinedVerdict('Warning', readNested({ verdict: 'Approve' }, F)), 'Warning')
  assert.equal(combinedVerdict('Approve', readNested(null, F)), 'INCOMPLETE')
  assert.equal(combinedVerdict('Warning', readNested(null, F)), 'Warning (INCOMPLETE)')
})

test('the report verdict line is raised only when the nested part is worse', () => {
  const text = '## Verdict\n✅ Approve — clean.\n\n## Gate'
  assert.equal(raiseVerdictLine(text, readNested({ verdict: 'Block' }, F)).split('\n')[1], '⛔ Block — clean. · raised by the nested adversarial-review of the files outside every profile')
  assert.equal(raiseVerdictLine(text, readNested({ verdict: 'Approve' }, F)), text)
  assert.match(raiseVerdictLine('## Verdict\n⚠️ INCOMPLETE — x', readNested({ verdict: 'Warning' }, F)), /⚠️ Warning \(INCOMPLETE\) — x/)
  assert.equal(raiseVerdictLine('no heading', readNested({ verdict: 'Block' }, F)), 'no heading')
})

test('the section labels the nested part, and the record field summarises it', () => {
  const ran = readNested({ verdict: 'Warning', confirmed: [MED], suspected: [MED], notRun: ['n'] }, F)
  const s = nestedSection(ran, true)
  assert.match(s, /## Files outside every profile — nested adversarial-review\nIts verdict: Warning · Files: web\/app\.js/)
  assert.match(s, /### Confirmed\n- Medium · `web\/app\.js:2` · t · d · Fix: f · \[adversarial-review\]/)
  assert.match(s, /### Suspected/)
  assert.match(s, /### Not run in it\n- n/)
  assert.match(s, /not posted on the PR/)
  assert.doesNotMatch(nestedSection(ran, false), /not posted/)
  assert.match(nestedSection(readNested(null, F), false), /It did not run \(it returned nothing\); these files were NOT reviewed/)
  const rec = nestedRecord(ran)
  assert.deepEqual([rec.name, rec.ran, rec.verdict, rec.findings.total, rec.findings.bySeverity.Medium, rec.notRun], ['adversarial-review', true, 'Warning', 2, 2, ['n']])
  assert.equal(nestedRecord(readNested(null, F)).verdict, null)
})

test('nesting is barred when nested itself, pinned or pointed at another repo; the launch args carry the whole base and _via', () => {
  /** @param {Record<string, unknown>} o */
  const run = o => /** @type {any} */ ({ viaArg: '', requestedLangs: undefined, repoArg: '', baseArg: '', intentArg: '', craftRootArg: '', A: {}, ...o })
  assert.equal(nestingBarred(run({})), '')
  assert.match(nestingBarred(run({ viaArg: 'rust-audit' })), /itself nested \(under rust-audit\)/)
  assert.match(nestingBarred(run({ requestedLangs: ['rust'] })), /pinned/)
  assert.match(nestingBarred(run({ repoArg: '/r' })), /takes no repo=/)
  assert.deepEqual(nestedLaunchArgs(run({}), F, 'main'), { diffBase: 'main', files: F, _via: 'review' })
  assert.deepEqual(nestedLaunchArgs(run({ baseArg: 'v1', intentArg: 'i', craftRootArg: '/c', A: { priorDecisions: [{ id: 'x' }] } }), F, ''),
    { diffBase: 'v1', files: F, _via: 'review', intent: 'i', craftRoot: '/c', priorDecisions: [{ id: 'x' }] })
  assert.equal('priorDecisions' in nestedLaunchArgs(run({ A: { priorDecisions: 'k=v' } }), F, 'main'), false)
})
