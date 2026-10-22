// The one verdict rule (realm @nick/craft, node #299): never Approve over what did not run.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { honestVerdict, honestVerdictLine } from './honest-verdict.mjs'

test('honestVerdict: nothing missing leaves the verdict as it came', () => {
  assert.equal(honestVerdict('Approve', []), 'Approve')
  assert.equal(honestVerdict('Approve (PARTIAL COVERAGE)', []), 'Approve (PARTIAL COVERAGE)')
  assert.equal(honestVerdict('Block', undefined), 'Block')
  assert.equal(honestVerdict('Warning', ['', '  ']), 'Warning', 'blank entries are not a gap')
})

test('honestVerdict: a green verdict over a gap is INCOMPLETE, never Approve', () => {
  for (const v of ['Approve', 'Approve (INCOMPLETE)', 'Healthy', 'Clean', '', null]) {
    assert.equal(honestVerdict(v, ['safety lens died']), 'INCOMPLETE', String(v))
  }
})

test('honestVerdict: a red verdict keeps its findings and is marked once', () => {
  assert.equal(honestVerdict('Block', ['x']), 'Block (INCOMPLETE)')
  assert.equal(honestVerdict('Warning (INCOMPLETE)', ['x']), 'Warning (INCOMPLETE)')
  assert.equal(honestVerdict('INCOMPLETE (detect died)', ['x']), 'INCOMPLETE (detect died)')
})

test('honestVerdictLine: the green word under the Verdict heading becomes INCOMPLETE and names the gap', () => {
  const out = honestVerdictLine('## Verdict\n\u2705 Approve \u2014 clean.\n\n## Gate\nCI', ['rust lenses that never returned'])
  const line = out.split('\n')[1]
  assert.match(String(line), /^\u26a0\ufe0f INCOMPLETE \u2014 clean\./)
  assert.match(String(line), /did not run: rust lenses that never returned/)
  assert.doesNotMatch(String(line), /Approve \(/)
  assert.ok(out.endsWith('## Gate\nCI'), 'the rest of the report is untouched')
})

test('honestVerdictLine: a suffixed Approve and a warning-marked Approve lose the Approve too', () => {
  const out = honestVerdictLine('## Verdict\n\u26a0\ufe0f Approve (INCOMPLETE) \u2014 x \u00b7 INCOMPLETE \u2014 part of this review did not run: a', ['a'])
  assert.equal(out.split('\n')[1], '\u26a0\ufe0f INCOMPLETE \u2014 x \u00b7 INCOMPLETE \u2014 part of this review did not run: a', 'no second list when one is there')
})

test('honestVerdictLine: an inline verdict line is found, and red lines and complete runs are left alone', () => {
  assert.match(honestVerdictLine('**Overall verdict:** Approve', ['semver']), /\*\*Overall verdict:\*\* \u26a0\ufe0f INCOMPLETE/)
  const block = '## Verdict\n\u26d4 Block \u2014 a Critical; approve nothing else'
  assert.equal(honestVerdictLine(block, ['x']), block)
  const clean = '## Verdict\n\u2705 Approve'
  assert.equal(honestVerdictLine(clean, []), clean)
  assert.equal(honestVerdictLine('no heading here', ['x']), 'no heading here')
})
