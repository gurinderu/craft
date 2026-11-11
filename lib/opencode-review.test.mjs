// The OpenCode review driver end to end over a fake `craft` (lib/codex-review-fakes.mjs, written through a child
// process) and a fake host child-session call: one step's tasks run as child sessions up to the limit, each on its
// OpenCode agent or with its Claude Code agent's body, its tier's model, the late ones abandoned, the failed one handed
// out again, the usage limit stopping the rest, and the binary's answer returned.
import { afterEach, beforeEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reviewInOpenCode } from './opencode-review.mjs'
import { FAKE_CRAFT, writeExecutable } from './codex-review-fakes.mjs'

/** @typedef {import('./opencode-review-task.mjs').ChildRequest} ChildRequest */

/** @type {string} */
let dir
/** @type {{ craft: string, run: string, repo: string, store: string }} */
let at
/** @type {ChildRequest[]} */
let asked
let live = 0
let most = 0

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-opencode-review-')))
  at = { craft: path.join(dir, 'craft'), run: path.join(dir, 'run'), repo: path.join(dir, 'repo'), store: path.join(dir, 'store') }
  fs.mkdirSync(at.repo)
  writeExecutable(at.craft, FAKE_CRAFT)
  asked = []
  live = 0
  most = 0
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** The fake child session: acts on a word in its prompt, as the fake codex does. @param {ChildRequest} req @returns {Promise<string>} */
async function child(req) {
  asked.push(req)
  live++
  most = Math.max(most, live)
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    if (req.prompt.includes('HANG')) await new Promise(resolve => setTimeout(resolve, 5000))
    if (/\bFAIL\b/.test(req.prompt)) throw new Error('boom')
    if (req.prompt.includes('LIMIT')) throw new Error("You've hit your usage limit. Try again in 3 hours.")
    if (req.prompt.includes('PROSE')) return 'I looked and it is fine.'
    return 'Here is my answer.\n\n```json\n{"answer": "ok"}\n```'
  } finally {
    live--
  }
}

/** @param {Array<{ id: string, prompt: string, model: string, agentType?: string }>} tasks @param {string} args */
function review(tasks, args) {
  const env = { PATH: process.env['PATH'], HOME: dir, FAKE_RUN: at.run, FAKE_TASKS: JSON.stringify(tasks) }
  return reviewInOpenCode(`craftBin=${at.craft} repo=${at.repo} ${args}`, { runChild: child, directory: at.repo, env, store: at.store, deadlineMs: () => 1000 })
}

/** The request whose prompt holds `word`. @param {string} word */
function askedWith(word) {
  const req = asked.find(r => r.prompt.includes(word))
  assert.ok(req, `no child session for ${word}`)
  return req
}
/** Every submit's argv. @returns {string[][]} */
const submits = () => fs.readFileSync(path.join(at.run, 'submits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
/** @param {string[]} argv @param {string} flag */
const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

const BATCH = [
  { id: 'rust', prompt: 'TASK-RUST', model: 'opus', agentType: 'rust-reviewer' },
  { id: 'nix', prompt: 'TASK-NIX', model: 'haiku', agentType: 'nix-reviewer' },
  { id: 'gone', prompt: 'TASK-GONE', model: 'sonnet', agentType: 'no-such-agent' },
  { id: 'fail', prompt: 'TASK FAIL', model: 'sonnet' },
  { id: 'late', prompt: 'TASK HANG', model: 'sonnet' },
]
const batch = () => review(BATCH, 'concurrency=2 opencodeModels=opus=anthropic/claude-big,haiku=anthropic/claude-small')

describe('a step\'s tasks', () => {
  test('run as child sessions up to the limit, each answer written to the task\'s file for the binary', async () => {
    const answer = await batch()
    assert.equal(most, 2, 'two at once, never more')
    const answered = new Map(JSON.parse(fs.readFileSync(path.join(at.run, 'answered.json'), 'utf8')))
    assert.deepEqual(JSON.parse(String(answered.get('rust.json'))), { answer: 'ok' })
    assert.match(answer, /^## Verdict\n\n✅ Approve — fake review/)
    assert.match(answer, /- \[High\] src\/a\.rs:3 — a fake finding \(confirmed\)/)
  })

  test('run on their OpenCode agent or with their Claude Code agent\'s body, and their tier\'s model', async () => {
    await batch()
    const rust = askedWith('TASK-RUST')
    assert.equal(rust.agent, 'rust-reviewer', 'rust-reviewer is the OpenCode agent of that name')
    assert.match(rust.prompt, /^The task below is your whole task/)
    assert.match(rust.prompt, /The JSON schema your answer must satisfy/)
    const nix = askedWith('TASK-NIX')
    assert.equal(nix.agent, '', 'no OpenCode agent: the session\'s default')
    assert.ok(nix.prompt.indexOf('TASK-NIX') > nix.prompt.indexOf('your whole task'), 'the Claude Code agent\'s body first')
    assert.deepEqual(['TASK-RUST', 'TASK-NIX', 'TASK-GONE'].map(w => askedWith(w).model), [
      { providerID: 'anthropic', modelID: 'claude-big' }, { providerID: 'anthropic', modelID: 'claude-small' }, undefined,
    ])
  })

  test('past their deadline are abandoned, a failed one handed out again, an agent with neither said degraded', async () => {
    await batch()
    const [first = []] = submits()
    assert.deepEqual(valuesOf(first, '--abandoned'), ['late'])
    assert.equal(asked.filter(r => r.prompt.includes('TASK FAIL')).length, 3, 'the first try and the binary\'s two retries')
    const degraded = valuesOf(first, '--degraded')
    assert.equal(degraded.length, 1)
    assert.match(String(degraded[0]), /no-such-agent.*OpenCode driver/)
  })
})

test('a final message with no JSON leaves no answer, and the binary asks again', async () => {
  await review([{ id: 'prose', prompt: 'PROSE', model: 'opus' }], '')
  assert.equal(asked.length, 3)
  assert.equal(fs.existsSync(path.join(at.run, 'answers', 'prose.json')), false)
})

test('a task on the usage limit starts no other, and the submit carries the limit', async () => {
  await review([{ id: 'a', prompt: 'LIMIT', model: 'opus' }, { id: 'b', prompt: 'TASK-B', model: 'opus' }], 'concurrency=1')
  assert.equal(asked.length, 1)
  assert.match(String(valuesOf(submits()[0] ?? [], '--limit')[0]), /hit your usage limit/)
})

test('arguments the driver cannot use are refused with nothing run', async () => {
  assert.match(await review([], 'languages=rust'), /INCOMPLETE — review cannot honour `languages`/)
  assert.match(await review([], 'concurrency=0'), /concurrency=0/)
  assert.match(await review([], 'opencodeModels=claude-big'), /not <provider>\/<model>/)
  assert.match(await review([], 'codexModels=x'), /INCOMPLETE/, 'the Codex driver\'s own name is not taken here')
  assert.equal(fs.existsSync(at.run), false)
  assert.equal(asked.length, 0)
})
