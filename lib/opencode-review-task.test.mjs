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
    assert.deepEqual(placementOf(/** @type {any} */ ({ agentType: 'rust-reviewer' }), /** @type {any} */ (where)), { agent: 'rust-reviewer', body: '', rubricless: '', degraded: '' })
    fs.mkdirSync(path.join(where.repo, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(where.repo, '.claude', 'agents', 'rust-reviewer.md'), '---\nname: x\n---\nOUR OWN RUST LENS\n')
    const consumer = placementOf(/** @type {any} */ ({ consumerAgent: 'rust-reviewer' }), /** @type {any} */ (where))
    assert.deepEqual(consumer, { agent: 'review-task', body: 'OUR OWN RUST LENS', rubricless: '', degraded: '' })
    assert.deepEqual(placementOf(/** @type {any} */ ({}), /** @type {any} */ (where)), { agent: 'review-task', body: '', rubricless: '', degraded: '' })
    assert.deepEqual(placementOf(/** @type {any} */ ({ agentType: 'gone' }), /** @type {any} */ (where)), { agent: 'review-task', body: '', rubricless: 'gone', degraded: '' })
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

/** A task laid out on disk, as the binary writes one. @param {string} dir @param {Record<string, unknown>} [over] */
function taskIn(dir, over = {}) {
  fs.writeFileSync(path.join(dir, 'p.md'), 'TASK')
  fs.writeFileSync(path.join(dir, 's.json'), '{}')
  return { id: 't', label: 't', model: 'opus', promptFile: path.join(dir, 'p.md'), schemaFile: path.join(dir, 's.json'), answerFile: path.join(dir, 'a', 't.json'), ...over }
}
const ANSWER = '```craft-answer\n{"answer":"ok"}\n```'

test('rust-reviewer missing from the runtime: the task runs on review-task with its body, said degraded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-task-'))
  try {
    /** @type {Array<{ agent: string, prompt: string }>} */
    const asked = []
    const ctx = { runChild: async (/** @type {any} */ r) => { asked.push(r); return ANSWER }, pluginRoot: ROOT, repo: dir, models: new Map(), agents: new Set(['build', 'review-task']) }
    const got = await runTask(/** @type {any} */ (taskIn(dir, { agentType: 'rust-reviewer' })), ctx)
    assert.equal(got.outcome, 'answered')
    assert.match(String(got.degraded), /`rust-reviewer`, an agent this OpenCode does not have, and ran on `review-task`/)
    assert.deepEqual(asked.map(r => r.agent), ['review-task'])
    assert.match(String(asked[0]?.prompt), /senior Rust reviewer/, 'the rust-reviewer body first')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a runtime that says the agent is not found gets the task again on review-task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-task-'))
  try {
    /** @type {string[]} */
    const agents = []
    const runChild = async (/** @type {any} */ r) => { agents.push(r.agent); if (r.agent === 'rust-reviewer') throw new Error('Agent rust-reviewer not found'); return ANSWER }
    const got = await runTask(/** @type {any} */ (taskIn(dir, { agentType: 'rust-reviewer' })), { runChild, pluginRoot: ROOT, repo: dir, models: new Map() })
    assert.deepEqual([agents, got.outcome, !!got.degraded], [['rust-reviewer', 'review-task'], 'answered', true])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('past its deadline the task is abandoned and its child session told to stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-task-'))
  try {
    /** @type {AbortSignal | undefined} */
    let seen
    const runChild = (/** @type {any} */ r) => { seen = r.signal; return new Promise(() => {}) }
    const got = await runTask(/** @type {any} */ (taskIn(dir)), { runChild, pluginRoot: ROOT, repo: dir, models: new Map(), deadlineMs: () => 20 })
    assert.equal(got.outcome, 'abandoned')
    assert.equal(seen?.aborted, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
