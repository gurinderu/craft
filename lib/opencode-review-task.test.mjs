// The OpenCode review task's own decisions: which read-only agent a task runs on and which model (what in a reply is
// the answer is pi's reader, lib/pi-review-answer.test.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelOf, placementOf, runTask } from './opencode-review-task.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

test('rust-reviewer runs on its OpenCode agent; a consumer\'s agent of that name on its own body', () => {
  const where = { pluginRoot: ROOT, repo: fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-task-')) }
  try {
    assert.deepEqual(placementOf(/** @type {any} */ ({ agentType: 'rust-reviewer' }), /** @type {any} */ (where)), { agent: 'rust-reviewer', body: '', rubricless: '' })
    fs.mkdirSync(path.join(where.repo, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(where.repo, '.claude', 'agents', 'rust-reviewer.md'), '---\nname: x\n---\nOUR OWN RUST LENS\n')
    const consumer = placementOf(/** @type {any} */ ({ consumerAgent: 'rust-reviewer' }), /** @type {any} */ (where))
    assert.deepEqual(consumer, { agent: 'review-task', body: 'OUR OWN RUST LENS', rubricless: '' })
    assert.deepEqual(placementOf(/** @type {any} */ ({}), /** @type {any} */ (where)), { agent: 'review-task', body: '', rubricless: '' })
    assert.deepEqual(placementOf(/** @type {any} */ ({ agentType: 'gone' }), /** @type {any} */ (where)), { agent: 'review-task', body: '', rubricless: 'gone' })
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
  assert.equal(got.outcome, 'unanswered')
  assert.match(got.why, /could not be read/)
  assert.equal(asked.length, 0)
})
