// Direct unit tests of lib/review-adjudicate.mjs at the edges review-adjudicate.test.mjs leaves open:
// the anchors of every marker-stripping pattern, the red-team classification's flags on each path,
// the boundaries of the two caps, and the untrusted shapes (null, absent, array-retired) the
// absorption helpers are handed by the engine.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  ATTACK_MAX, sanitizeAttack, baseWhy, isHighSeverity, classifyRedTeam, adjudicateOne, shouldRedTeam,
  carriedKey, findCarrier, clampField, noteAbsorbed, absorbedSite, absorbInto, splitAbsorbed,
  withoutAbsorbed, absorbedPromptBlock, partitionAbsorbed, absorbAcross, markTrackedUnverified, TRACKED_MARK,
} from './review-adjudicate.mjs'

/** @typedef {import('./review-adjudicate.mjs').Finding} Finding */

const ALSO = ' — also reported at '
/** @type {{ note?: string }} */
const NO_NOTE = {}

test('sanitizeAttack breaks a multi-digit overflow counter and the reopened marker', () => {
  assert.equal(sanitizeAttack('a — (+12 more report(s) at this site)'), 'a (12 more report(s) at this site)')
  assert.equal(sanitizeAttack('x (reopened: y)'), 'x (reopened y)')
})

test('sanitizeAttack keeps a text of exactly ATTACK_MAX characters whole', () => {
  const exact = 'a'.repeat(ATTACK_MAX)
  assert.equal(sanitizeAttack(exact), exact)
  assert.equal(sanitizeAttack(`${exact}b`), `${exact}…`)
})

test('baseWhy strips each trailing marker with any trailing whitespace', () => {
  assert.equal(baseWhy('r (reopened: x)  '), 'r')
  assert.equal(baseWhy('r — still-open (adjudicator did not run — agent died) \n'), 'r')
  assert.equal(baseWhy('r — REGRESSED after fix (no detail returned) '), 'r')
  assert.equal(baseWhy('r — UNVERIFIED (adjudicator could not tell why)'), 'r')
  assert.equal(baseWhy('r — UNVERIFIED (adjudicator could not tell)  '), 'r')
})

test('baseWhy leaves a marker that does not END the rationale alone', () => {
  for (const why of [
    'r (reopened: x) and more',
    'r — still-open (adjudicator did not run x) and more',
    'r — REGRESSED after fix (no detail x) and more',
    'r — UNVERIFIED (adjudicator could not tell x) and more',
  ]) assert.equal(baseWhy(why), why)
})

test('isHighSeverity reads a padded severity', () => {
  assert.equal(isHighSeverity(' High '), true)
  assert.equal(isHighSeverity(' critical\n'), true)
})

test('classifyRedTeam passes a non-High prior through untouched, red-team or not', () => {
  const adj = { status: 'resolved' }
  const out = classifyRedTeam({ severity: 'Low' }, adj, null)
  assert.deepEqual(out, { adj, died: false, overturned: false, invalid: false })
  assert.equal(out.adj, adj)
})

test('classifyRedTeam: a red-team that did not defeat the fix leaves the verdict as it was', () => {
  const adj = { status: 'resolved' }
  const out = classifyRedTeam({ severity: 'High' }, adj, { defeated: false, attack: 'tried x' })
  assert.deepEqual(out, { adj, died: false, overturned: false, invalid: false })
})

test('classifyRedTeam: a dead red-team appends to the note and raises only `died`', () => {
  const withNote = classifyRedTeam({ severity: 'High' }, { note: 'n' }, null)
  assert.match(/** @type {string} */ (withNote.adj.note), /^n \[red-team did not run — agent died/)
  assert.deepEqual([withNote.died, withNote.overturned, withNote.invalid], [true, false, false])
  assert.match(/** @type {string} */ (classifyRedTeam({ severity: 'High' }, NO_NOTE, undefined).adj.note), /^\[red-team did not run/)
})

test('classifyRedTeam: defeat without an attack is invalid, appended to the note, raising only `invalid`', () => {
  const withNote = classifyRedTeam({ severity: 'Critical' }, { note: 'n' }, { defeated: true, attack: '**' })
  assert.match(/** @type {string} */ (withNote.adj.note), /^n \[red-team claimed defeat with no attack/)
  assert.deepEqual([withNote.died, withNote.overturned, withNote.invalid], [false, false, true])
  assert.match(/** @type {string} */ (classifyRedTeam({ severity: 'Critical' }, NO_NOTE, { defeated: true }).adj.note), /^\[red-team claimed defeat/)
})

test('classifyRedTeam: a real defeat overturns, raising only `overturned`', () => {
  const out = classifyRedTeam({ severity: 'High' }, { status: 'resolved' }, { defeated: true, attack: 'still reachable' })
  assert.deepEqual(out, { adj: { status: 'still-open', attack: '(red-team) still reachable' }, died: false, overturned: true, invalid: false })
})

test('adjudicateOne closes a clean resolved verdict on the resolved track', () => {
  const out = adjudicateOne({ file: 'a', why: 'w' }, { status: 'resolved' })
  assert.equal(out.track, 'resolved')
  assert.equal(out.entry.disposition, 'closed')
})

test('shouldRedTeam and carriedKey take an absent verdict or finding', () => {
  assert.equal(shouldRedTeam(null), false)
  assert.equal(carriedKey(null), '')
  assert.equal(carriedKey({ file: 'A.rs', ruleId: ' R1 ' }), carriedKey({ file: 'a.rs', ruleId: 'r1' }))
})

test('findCarrier falls back to the matcher when only ONE side has a key, and takes no priors as none', () => {
  const prior = { file: 'a.rs', title: 't' }
  assert.equal(findCarrier({ file: 'a.rs', ruleId: 'R' }, [prior], () => true), prior)
  assert.equal(findCarrier({ file: 'a.rs' }, null, () => true), null)
})

test('clampField keeps a field of exactly the cap whole', () => {
  assert.equal(clampField('abc', 3), 'abc')
  assert.equal(clampField('abcd', 3), 'abc…')
})

test('noteAbsorbed, absorbedSite, absorbInto and withoutAbsorbed read an absent text as empty', () => {
  assert.equal(absorbedSite(null), '?:0: untitled')
  assert.equal(noteAbsorbed(undefined, { file: 'a', line: 1, title: 't' }), `${ALSO}a:1: t`)
  assert.equal(absorbInto(null, { file: 'a', line: 1, title: 't' }), `${ALSO}a:1: t`)
  assert.equal(withoutAbsorbed(null), '')
})

test('the overflow counter past ABSORBED_MAX counts on from a multi-digit value', () => {
  const full = `r${ALSO}a:1: x${ALSO}a:2: x${ALSO}a:3: x — (+12 more report(s) at this site)`
  assert.equal(noteAbsorbed(full, { file: 'a', line: 4, title: 'x' }), `r${ALSO}a:1: x${ALSO}a:2: x${ALSO}a:3: x — (+13 more report(s) at this site)`)
  assert.deepEqual(splitAbsorbed(full), { base: 'r', sites: ['a:1: x', 'a:2: x', 'a:3: x'], more: 12 })
})

test('splitAbsorbed trims each site and drops an empty one', () => {
  assert.deepEqual(splitAbsorbed(`r${ALSO}a:1: t ${ALSO}`), { base: 'r', sites: ['a:1: t'], more: 0 })
})

test('absorbedPromptBlock lists one site per line and counts overflow only when there is any', () => {
  const block = absorbedPromptBlock(`r${ALSO}a:1: x${ALSO}b:2: y`)
  assert.match(block, /\n {2}- a:1: x\n {2}- b:2: y\n/)
  assert.doesNotMatch(block, /further report/)
})

test('partitionAbsorbed honours a retired ARRAY and takes absent lists as empty', () => {
  const host = { file: 'a.rs', ruleId: 'R', why: 'w' }
  const f = { file: 'a.rs', ruleId: 'R', title: 't' }
  const atRetired = partitionAbsorbed([f], [host], [host])
  assert.deepEqual([atRetired.kept, atRetired.keptAtRetired, atRetired.absorbed], [[f], 1, 0])
  const live = partitionAbsorbed([f], [host], null)
  assert.deepEqual([live.kept, live.absorbed], [[], 1])
  const none = partitionAbsorbed(null, [host], null, () => true)
  assert.deepEqual([none.kept, none.absorbed], [[], 0])
  assert.deepEqual(absorbAcross(null, [host], null).runs, [])
})

test('markTrackedUnverified honours a retired array and absent lists, and tolerates a hole among priors', () => {
  const host = { file: 'a.rs', ruleId: 'R', why: 'w', tier: 'unverified' }
  const f = /** @type {Finding} */ ({ file: 'a.rs', ruleId: 'R' })
  assert.deepEqual(markTrackedUnverified([f], [host], [host]).kept, [f])
  assert.deepEqual(markTrackedUnverified(null, [host], null).kept, [])
  assert.deepEqual(markTrackedUnverified([f], null, null, () => true), { kept: [f], marked: 0, collapsed: 0, updates: new Map() })
  const holed = /** @type {Finding[]} */ (/** @type {unknown} */ ([null, host]))
  const out = markTrackedUnverified([f], holed, null)
  assert.equal(out.collapsed, 1)
  assert.equal(out.kept[0]?.why, TRACKED_MARK, 'a finding with no rationale carries the mark alone')
})
