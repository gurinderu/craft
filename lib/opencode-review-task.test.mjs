// The OpenCode review task's own decisions: which agent a task runs on, which model, and what in a final message is
// the answer.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answerOf, modelOf, placementOf, runTask } from './opencode-review-task.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

test('the answer is the last fenced JSON block, else the outermost braces; anything else is none', () => {
  assert.deepEqual(answerOf('first\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(answerOf('```\n{"a":3}\n```'), { a: 3 })
  assert.deepEqual(answerOf('The answer: {"a": {"b": 4}} — done'), { a: { b: 4 } })
  assert.equal(answerOf('no json here'), undefined)
  assert.equal(answerOf('```json\n[1, 2]\n```'), undefined, 'an array is not an answer object')
  assert.equal(answerOf('{"a": '), undefined)
})

test('rust-reviewer runs on its OpenCode agent; a consumer\'s agent of that name on its own body', () => {
  const where = { pluginRoot: ROOT, repo: fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-task-')) }
  try {
    assert.deepEqual(placementOf(/** @type {any} */ ({ agentType: 'rust-reviewer' }), /** @type {any} */ (where)), { agent: 'rust-reviewer', body: '', rubricless: '' })
    fs.mkdirSync(path.join(where.repo, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(where.repo, '.claude', 'agents', 'rust-reviewer.md'), '---\nname: x\n---\nOUR OWN RUST LENS\n')
    const consumer = placementOf(/** @type {any} */ ({ consumerAgent: 'rust-reviewer' }), /** @type {any} */ (where))
    assert.deepEqual(consumer, { agent: '', body: 'OUR OWN RUST LENS', rubricless: '' })
    assert.deepEqual(placementOf(/** @type {any} */ ({}), /** @type {any} */ (where)), { agent: '', body: '', rubricless: '' })
  } finally {
    fs.rmSync(where.repo, { recursive: true, force: true })
  }
})

test('a tier\'s model is the table\'s provider/model, none when the table leaves it to the session', () => {
  const table = new Map([['opus', 'anthropic/claude-x'], ['haiku', 'openrouter/meta/llama']])
  assert.deepEqual(modelOf(table, 'opus'), { providerID: 'anthropic', modelID: 'claude-x' })
  assert.deepEqual(modelOf(table, 'haiku'), { providerID: 'openrouter', modelID: 'meta/llama' })
  assert.equal(modelOf(table, 'sonnet'), undefined)
})

test('a task whose prompt cannot be read fails without a session', async () => {
  /** @type {unknown[]} */
  const asked = []
  const t = { id: 't', label: 't', model: 'opus', promptFile: '/nonexistent/p.md', schemaFile: '/nonexistent/s.json', answerFile: '/nonexistent/a.json' }
  const got = await runTask(t, { runChild: async r => { asked.push(r); return '' }, pluginRoot: ROOT, repo: ROOT, models: new Map() })
  assert.equal(got.outcome, 'failed')
  assert.match(got.why, /could not be read/)
  assert.equal(asked.length, 0)
})
