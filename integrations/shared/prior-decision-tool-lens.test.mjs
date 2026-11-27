// Two gate tool lenses are one lens for an outright match when the tool rule is the same (realm @nick/craft,
// node #718): the memory writes `tool`, the gate prints the tool's name — twin of
// cli/crates/craft-review/src/memory/matching/tests.rs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { findingPlan, MATCHED_BY_RULE } from './prior-decision-match.mjs'

const RULE = 'clippy::redundant_pub_crate'
/** @param {string} lens @param {string} rule @returns {any} */
const rec = (lens, rule) => ({
  id: 'decision-c540c47bcf',
  kind: 'decision',
  title: 'pub(crate) function inside private module',
  scope: 'src/deferral.rs',
  reason: 'r',
  who: 'a',
  when: '2026-11-27',
  link: '',
  commit: '',
  deferred: false,
  supersedes: [],
  line: 20,
  lens,
  toolRule: rule,
})
/** @param {string} lens @param {string} rule @returns {any} */
const fnd = (lens, rule) => ({ title: 'pub(crate) function inside private module', file: 'src/deferral.rs', line: 20, lens, toolRule: rule, severity: 'Low' })
/** @param {any} f @param {any} d */
const outcome = (f, d) => {
  const p = findingPlan(f, [d])
  return [p.sure?.how, p.disputed.length]
}

test('a tool record meets another tool lens of the same rule outright', () => {
  assert.deepEqual(outcome(fnd('clippy-pedantic', RULE), rec('tool', RULE)), [MATCHED_BY_RULE, 0])
  assert.equal(outcome(fnd('tool', 'redundant_pub_crate'), rec('clippy', RULE))[0], MATCHED_BY_RULE, 'the rule compares without its tool prefix')
})

test('another rule or a review lens keeps its old path', () => {
  assert.deepEqual(outcome(fnd('clippy-pedantic', 'clippy::needless_borrow'), rec('tool', RULE)), [undefined, 0], 'another rule is another finding')
  assert.deepEqual(outcome(fnd('clippy-pedantic', RULE), rec('correctness', RULE)), [undefined, 1], "a review lens's record goes to the judge")
  assert.deepEqual(outcome(fnd('clippy-pedantic', RULE), rec('', RULE)), [undefined, 1], 'a record with no lens goes to the judge')
})
