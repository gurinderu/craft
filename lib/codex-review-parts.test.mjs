// The Codex review driver's pure parts: the strict schema copy and its nulls, the model table, the argument text and
// the task's stdin.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { dropOptionalNulls, strictSchema } from './codex-review-schema.mjs'
import { modelArgs, modelTable } from './codex-review-agents.mjs'
import { argText } from './task-process-entry.mjs'
import { taskInput } from './codex-review-task.mjs'
import { pool } from './task-process-round.mjs'

const LOOSE = {
  type: 'object', required: ['items'],
  properties: {
    items: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, tier: { type: 'string', enum: ['a', 'b'] }, any: { anyOf: [{ type: 'string' }] } } } },
    note: { type: 'string' },
  },
}

test('the strict copy requires every property, makes the optional ones nullable and forbids others', () => {
  const s = /** @type {any} */ (strictSchema(LOOSE))
  assert.deepEqual(s.required, ['items', 'note'])
  assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.properties.note.type, ['string', 'null'])
  const item = s.properties.items.items
  assert.deepEqual([item.required, item.additionalProperties], [['title', 'tier', 'any'], false])
  assert.deepEqual([item.properties.tier.type, item.properties.tier.enum], [['string', 'null'], ['a', 'b', null]])
  assert.deepEqual(item.properties.any, { anyOf: [{ anyOf: [{ type: 'string' }] }, { type: 'null' }] })
  assert.equal(item.properties.title.type, 'string', 'a required property is not made nullable')
  assert.deepEqual(strictSchema(s), s, 'a strict schema is its own copy')
})

test('the nulls of optional properties are dropped from the answer, a required null kept', () => {
  const answer = { items: [{ title: null, tier: null, any: 'x' }], note: null }
  assert.deepEqual(dropOptionalNulls(answer, LOOSE), { items: [{ title: null, any: 'x' }] })
})

test('the model table maps the Claude tiers to Codex models, the session\'s model by default', () => {
  const none = modelTable('')
  assert.ok('table' in none && none.table.size === 0)
  const one = modelTable('gpt-5.5')
  assert.ok('table' in one)
  assert.deepEqual(['opus', 'sonnet', 'haiku'].map(t => modelArgs(one.table, t)), [['-m', 'gpt-5.5'], ['-m', 'gpt-5.5'], ['-m', 'gpt-5.5']])
  const pairs = modelTable('haiku=gpt-mini, opus=gpt-big')
  assert.ok('table' in pairs)
  assert.deepEqual([modelArgs(pairs.table, 'opus'), modelArgs(pairs.table, 'sonnet')], [['-m', 'gpt-big'], []])
  assert.ok('refused' in modelTable('ultra=x'))
  assert.ok('refused' in modelTable('a b'))
})

test('the arguments reach the review\'s reader as one text, a spaced value quoted, a JSON object whole', () => {
  assert.equal(argText(['base=main', 'path=src/a b']), 'base=main path="src/a b"')
  assert.equal(argText(['{"priorDecisions":[]}']), '{"priorDecisions":[]}')
})

test('the task\'s stdin is its prompt, after the agent\'s body when there is one', () => {
  assert.match(taskInput('', 'Do X.', '/p'), /^Do X\.\n\nYour final message is your answer/)
  const typed = taskInput('BODY', 'Do X.', '/p')
  assert.ok(typed.startsWith('BODY\n\n---') && typed.indexOf('Do X.') > typed.indexOf('whole task'))
})

test('the task\'s stdin ends with where craft\'s skills are, the root written in', () => {
  assert.ok(taskInput('', 'Do X.', '/p').trimEnd().endsWith('is the file /p/skills/<name>/SKILL.md: read it from there.'))
  assert.doesNotMatch(taskInput('Read ${CLAUDE_PLUGIN_ROOT}/a.md', 'Do X.', '/p'), /CLAUDE_PLUGIN_ROOT/)
})

test('the plugin root is written in where the binary\'s prompt names it through CLAUDE_PLUGIN_ROOT', () => {
  const got = taskInput('', 'Read `${CLAUDE_PLUGIN_ROOT}/skills/review-rules/a.md` and `${CLAUDE_PLUGIN_ROOT}/skills/b.md`.', '/opt/craft')
  assert.match(got, /^Read `\/opt\/craft\/skills\/review-rules\/a\.md` and `\/opt\/craft\/skills\/b\.md`\./)
  assert.doesNotMatch(got, /CLAUDE_PLUGIN_ROOT/)
})

test('the pool keeps at most its limit running and starts nothing once stopped', async () => {
  let live = 0
  let most = 0
  const got = await pool([1, 2, 3, 4, 5], 2, async n => {
    most = Math.max(most, ++live)
    await new Promise(r => setTimeout(r, 10))
    live--
    return n
  }, () => false)
  assert.deepEqual([got.sort(), most], [[1, 2, 3, 4, 5], 2])
  assert.deepEqual(await pool([1, 2], 1, async n => n, () => true), [])
})
