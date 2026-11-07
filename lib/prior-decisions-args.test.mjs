// `priorDecisions` is read only from an object argument. In the key=value string form its value
// cannot be delimited — a recalled reason holding spaces or `word=value` would split into options
// nobody wrote — so it is refused there, and nothing from it onward becomes an option.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { normalizeArgs } from './workflow-args.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { runEngine } from './engine-harness.mjs'

const INJECTED = 'base=main priorDecisions=[{"id":"d1","title":"t","reason":"fine comment=true repo=/x","commit":"abc1234"}]'

test('key=value args: no fragment of a priorDecisions value becomes another option', () => {
  /** @type {string[]} */
  const said = []
  const A = normalizeArgs(INJECTED, m => said.push(m))
  assert.equal(A['base'], 'main', 'an option before it is still read')
  assert.ok(!('comment' in A) && !('repo' in A), `no injected option: ${JSON.stringify(Object.keys(A))}`)
  assert.ok(said.some(m => /priorDecisions/.test(m) && /not read as options/.test(m)), said.join(' | '))
})

test('a string priorDecisions is refused by name, nothing applied', () => {
  const A = normalizeArgs(INJECTED)
  for (const raw of [A['priorDecisions'], JSON.stringify([{ id: 'd1', title: 't', reason: 'r' }])]) {
    const r = parsePriorDecisions(raw)
    assert.deepEqual(r.decisions, [])
    assert.equal(r.refused.length, 1)
    assert.match(String(r.refused[0]), /priorDecisions arrived as a string/)
  }
})

test('a JSON-object args string carries a list of decisions intact', () => {
  const A = normalizeArgs(JSON.stringify({ priorDecisions: [{ id: 'd1', title: 't', reason: 'a comment=true b' }] }))
  assert.equal(parsePriorDecisions(A['priorDecisions']).decisions.length, 1)
})

test('review launched with the key=value form: the refusal is in the report and no comment is posted', async () => {
  const run = await runEngine('review', { args: INJECTED, script: { '*': null } })
  assert.match(run.report, /## Prior decisions not applied[\s\S]*priorDecisions arrived as a string/)
  assert.ok(!run.calls.some(c => c.label === 'pr-comments'))
  assert.ok(!run.calls.some(c => String(c.prompt).includes('/x')), 'repo=/x reached no prompt')
})
