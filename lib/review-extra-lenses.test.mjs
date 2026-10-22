// The consumer's agents as extra lenses: parsing, discovery and the report's account (realm @nick/craft,
// node #295). The engine-level behaviour is pinned in review-extra-lenses-engine.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseExtraLenses, pickRepoReviewers, extraLensSection } from './review-extra-lenses.mjs'

test('parseExtraLenses: absent discovers, empty or off turns it off, a list names, a bad name is refused', () => {
  assert.deepEqual(parseExtraLenses(undefined), { how: 'discovered', agents: [], refused: [] })
  assert.deepEqual(parseExtraLenses(undefined, false), { how: 'off', agents: [], refused: [] })
  assert.equal(parseExtraLenses(['r'], false).how, 'named')
  for (const off of [[], '', false, 'none', 'false']) assert.equal(parseExtraLenses(off).how, 'off', JSON.stringify(off))
  assert.deepEqual(parseExtraLenses(['reviewer', 'reviewer', 'team.sec-v2']), { how: 'named', agents: ['reviewer', 'team.sec-v2'], refused: [] })
  assert.deepEqual(parseExtraLenses('reviewer, critic'), { how: 'named', agents: ['reviewer', 'critic'], refused: [] })
  assert.deepEqual(parseExtraLenses(['ok', 'bad name;rm']), { how: 'named', agents: ['ok'], refused: ['bad name;rm'] })
})

test('pickRepoReviewers finds a reviewer under another name and skips editors, non-reviewers and craft agents', () => {
  const defs = [
    { name: 'code-critic', description: 'Reads a diff or PR and reviews it for defects.', tools: 'Read, Grep' },
    // No `tools` line inherits every tool; only a disallowedTools taking every edit tool away makes it read-only.
    { name: 'locked-reviewer', description: 'Reviews a PR.', tools: '', disallowedTools: 'Edit, Write, MultiEdit, NotebookEdit' },
    { name: 'half-locked', description: 'Reviews a PR.', tools: '', disallowedTools: 'Edit, Write' },
    { name: 'open-reviewer', description: 'Reviews a PR.' },
    { name: 'star-reviewer', description: 'Reviews a PR.', tools: '*' },
    { name: 'fixer', description: 'Reviews findings and applies fixes to the code.', tools: 'Read, Bash' },
    { name: 'editor-reviewer', description: 'Reviews a PR.', tools: 'Read, Edit, Bash' },
    { name: 'verifier', description: 'Cold acceptance of a claim. Not for writing fixes, reviewing design or code.', tools: 'Read' },
    { name: 'craft:rust-reviewer', description: 'Reviews Rust diffs.', tools: 'Read' },
    { name: 'auditor', description: 'Security audit of the change.', tools: ['Read', 'Grep'] },
    { name: '', description: 'Reviews diffs.' },
    null,
  ]
  assert.deepEqual(pickRepoReviewers(defs), ['code-critic', 'locked-reviewer', 'auditor'])
  assert.deepEqual(pickRepoReviewers('nope'), [])
})

test('extraLensSection says how the lenses were chosen, which ran, each gap, and when none was found', () => {
  assert.equal(extraLensSection({ how: 'off', ran: [], failed: [], discovery: '' }), '')
  assert.match(extraLensSection({ how: 'discovered', ran: [], failed: [], discovery: '3 read' }), /No repo reviewer found: 3 read/)
  assert.match(extraLensSection({ how: 'discovered', ran: [], failed: [], discovery: '' }), /No repo reviewer found: none of/)
  const named = extraLensSection({ how: 'named', ran: ['reviewer'], failed: [{ agent: 'ghost', why: 'not registered' }], discovery: '' })
  assert.match(named, /named by the caller/)
  assert.match(named, /Ran: reviewer\./)
  assert.match(named, /coverage gap: ghost -- not registered/)
  const soft = extraLensSection({ how: 'discovered', ran: [], failed: [{ agent: 'x', why: 'died' }], discovery: '' })
  assert.match(soft, /discovered among.*\nRan: none\.\n- x could not run: died \(discovered, not named, so no coverage gap\)\./)
  assert.doesNotMatch(soft, /coverage gap: x/)
})

test('on an exit before the lenses: discovery says it did not run, a named lens is a gap or not needed', () => {
  const d = extraLensSection({ how: 'discovered', ran: [], failed: [], discovery: '', exit: { reason: 'no profile', needed: true } })
  assert.match(d, /## Extra lenses\nDiscovery did not run \(no profile\)\./)
  assert.doesNotMatch(d, /No repo reviewer found/)
  const gap = extraLensSection({ how: 'named', ran: [], failed: [{ agent: 'r', why: 'not run: gate red' }], discovery: '', exit: { reason: 'gate red', needed: true } })
  assert.match(gap, /Ran: none\.\n- .* coverage gap: r -- not run: gate red/)
  const idle = extraLensSection({ how: 'named', ran: [], failed: [], discovery: '', exit: { reason: 'the diff is empty', needed: false } })
  assert.match(idle, /Ran: none\. Not needed \(the diff is empty\)/)
  assert.doesNotMatch(idle, /coverage gap/)
  assert.equal(extraLensSection({ how: 'off', ran: [], failed: [], discovery: '', exit: { reason: 'x', needed: true } }), '')
})
