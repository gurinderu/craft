// The light profile's pure helpers (realm @nick/craft, node #295); the engine-level behaviour is
// pinned in review-light-profile.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseDepth, lightLenses, lightForcedLenses, lightCalledForLenses, depthVerifyTier, lightUnverifiedWhy, markVerdictLight, lightSection } from './review-depth.mjs'

test('parseDepth: absent and full are full, light is light, anything else is full and named', () => {
  assert.deepEqual(parseDepth(undefined), { depth: 'full', unknown: '' })
  assert.deepEqual(parseDepth(''), { depth: 'full', unknown: '' })
  assert.deepEqual(parseDepth('full'), { depth: 'full', unknown: '' })
  assert.deepEqual(parseDepth(' Light '), { depth: 'light', unknown: '' })
  assert.deepEqual(parseDepth('quick'), { depth: 'full', unknown: 'quick' })
})

test('lightLenses keeps the diff-scoped lenses, names the whole-diff ones, and never keeps nothing', () => {
  const whole = ['intent', 'compat']
  assert.deepEqual(lightLenses(['safety', 'intent', 'errors', 'compat'], whole, ['x']), { kept: ['safety', 'errors'], skipped: ['intent', 'compat'] })
  assert.deepEqual(lightLenses(['intent'], whole, ['safety', 'compat', 'tests']), { kept: ['safety', 'tests'], skipped: ['intent'] })
  assert.deepEqual(lightLenses(['safety', 'intent', 'compat'], whole, [], ['tests', 'intent']), { kept: ['safety', 'intent', 'tests'], skipped: ['compat'] })
})

test('lightForcedLenses: tests and intent on a production change the roster offers, none on a test-only diff', () => {
  const rs = ["'*.rs'"]
  assert.deepEqual(lightForcedLenses(['src/lib.rs'], rs, ['safety', 'tests', 'intent']), ['tests', 'intent'])
  assert.deepEqual(lightForcedLenses(['src/lib.rs'], rs, ['purity', 'intent']), ['intent'])
  assert.deepEqual(lightForcedLenses(['tests/it.rs', 'src/foo_test.rs', 'README.md'], rs, ['tests', 'intent']), [])
  assert.deepEqual(lightForcedLenses(['src/crd/spec.rs'], rs, ['tests', 'intent']), ['tests', 'intent'], 'a Rust spec.rs is production code')
})

test('depthVerifyTier: light skips below Medium whatever the rule, full keeps its own tier', () => {
  assert.equal(depthVerifyTier('individual', 'Low', 'light'), 'skip')
  assert.equal(depthVerifyTier('skip', 'Info', 'light'), 'skip')
  assert.equal(depthVerifyTier('skip', undefined, 'light'), 'skip')
  assert.equal(depthVerifyTier('batch', 'Medium', 'light'), 'batch')
  assert.equal(depthVerifyTier('individual', 'High', 'light'), 'individual')
  assert.equal(depthVerifyTier('individual', 'Low', 'full'), 'individual')
  assert.match(lightUnverifiedWhy('Low'), /light pass.*Low finding/)
  assert.match(lightUnverifiedWhy(undefined), /unrated/)
})

test('markVerdictLight amends the verdict line once, and marks a report without one', () => {
  const r = markVerdictLight('## Verdict\n\nApprove -- fine\n\n## Gate')
  assert.match(r, /^## Verdict\n\nApprove -- fine · light pass \(depth=light\)/)
  assert.equal(markVerdictLight(r), r)
  assert.match(markVerdictLight('no heading'), /^Light pass \(depth=light\).*\nno heading$/)
  assert.match(markVerdictLight('## Verdict\n'), /^Light pass/)
})

test('lightSection names the skipped lenses, the single round, the critic and the unverified Low', () => {
  const s = lightSection(['intent', 'compat'])
  for (const want of [/LIGHT pass/, /intent, compat were NOT dispatched/, /ONE round/, /critic did not run/, /Low and Info findings were not verified[^.]*except those two or more lenses reported with a must-fix harm claimed, which were/]) assert.match(s, want)
  assert.match(lightSection([]), /no whole-diff lens was in the plan/)
  const none = lightSection(['intent'], false)
  assert.match(none, /no lens ran/)
  assert.doesNotMatch(none, /ONE round/)
})

test('lightCalledForLenses: reconciler and failure-windows on controller code, compat on a contract path, nothing on a plain diff', () => {
  const roster = ['safety', 'reconciler', 'failure-windows', 'compat']
  assert.deepEqual(lightCalledForLenses(['src/lib.rs'], false, roster), [])
  assert.deepEqual(lightCalledForLenses(['src/controller.rs'], true, roster), ['reconciler', 'failure-windows'])
  assert.deepEqual(lightCalledForLenses(['crds/widget.yaml'], false, roster), ['compat'])
  assert.deepEqual(lightCalledForLenses(['crds/widget.yaml'], true, ['safety', 'compat']), ['compat'], 'only what the roster offers')
  assert.deepEqual(lightCalledForLenses(['tests/crds/widget.yaml'], false, roster), [], 'a test fixture is not the contract')
})

test('lightSection names the whole-diff lenses the light pass did run', () => {
  assert.match(lightSection(['negative-space'], true, ['failure-windows']), /negative-space were NOT dispatched \(it DID run failure-windows, which the diff called for\)/)
  assert.doesNotMatch(lightSection(['negative-space']), /DID run/)
})
