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
    { name: 'code-critic', description: 'Reads a diff or PR and reviews it for defects.', tools: '' },
    { name: 'fixer', description: 'Reviews findings and applies fixes to the code.', tools: '' },
    { name: 'editor-reviewer', description: 'Reviews a PR.', tools: 'Read, Edit, Bash' },
    { name: 'verifier', description: 'Cold acceptance of a claim. Not for writing fixes, reviewing design or code.', tools: '' },
    { name: 'craft:rust-reviewer', description: 'Reviews Rust diffs.', tools: '' },
    { name: 'auditor', description: 'Security audit of the change.', tools: ['Read', 'Grep'] },
    { name: '', description: 'Reviews diffs.' },
    null,
  ]
  assert.deepEqual(pickRepoReviewers(defs), ['code-critic', 'auditor'])
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
  assert.match(extraLensSection({ how: 'discovered', ran: [], failed: [{ agent: 'x', why: 'died' }], discovery: '' }), /discovered among.*\nRan: none\./)
})
