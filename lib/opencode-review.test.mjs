// The OpenCode review driver end to end over a fake `craft` (lib/codex-review-fakes.mjs, written through a child
// process) and a fake host child-session call: one step's tasks run as child sessions up to the limit, each read-only
// — on the OpenCode agent `rust-reviewer` names, every other on `review-task` with its Claude Code agent's body — on
// its tier's model, the late ones abandoned, the failed one handed out again, the usage limit stopping the rest, and
// the binary's answer returned.
import { afterEach, beforeEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reviewInOpenCode } from './opencode-review.mjs'
import { FAKE_CRAFT, writeExecutable } from './codex-review-fakes.mjs'

/** @typedef {import('./opencode-review-task.mjs').ChildRequest & { task: string }} Asked  task: the prompt file the message named, as read */

/** @type {string} */
let dir
/** @type {{ craft: string, run: string, repo: string, store: string }} */
let at
/** @type {Asked[]} */
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

/** What the fake session does with the task the message names: a word in it, as the fake codex acts. @param {string} task @returns {Promise<string>} */
async function act(task) {
  await new Promise(resolve => setTimeout(resolve, 20))
  if (task.includes('HANG')) await new Promise(resolve => setTimeout(resolve, 5000))
  if (/\bFAIL\b/.test(task)) throw new Error('boom')
  if (task.includes('LIMIT')) throw new Error("You've hit your usage limit. Try again in 3 hours.")
  if (task.includes('PROSE')) return 'I looked and it is fine.'
  return 'Here is my answer.\n\n```craft-answer\n{"answer": "ok"}\n```'
}

/** The fake child session. @param {import('./opencode-review-task.mjs').ChildRequest} req @returns {Promise<string>} */
async function child(req) {
  const file = /Read the file (\S+) and do exactly what it says/.exec(req.prompt)?.[1] ?? ''
  const task = fs.readFileSync(file, 'utf8')
  asked.push({ ...req, task })
  live++
  most = Math.max(most, live)
  try {
    return await act(task)
  } finally {
    live--
  }
}

/** @param {Array<{ id: string, prompt: string, model: string, agentType?: string }>} tasks @param {string} args @param {Set<string> | null} [agents] */
function review(tasks, args, agents = null) {
  const env = { PATH: process.env['PATH'], HOME: dir, FAKE_RUN: at.run, FAKE_TASKS: JSON.stringify(tasks) }
  return reviewInOpenCode(`craftBin=${at.craft} repo=${at.repo} ${args}`, { runChild: child, directory: at.repo, agents, env, store: at.store, deadlineMs: () => 1000 })
}

/** The request whose task holds `word`. @param {string} word */
function askedWith(word) {
  const req = asked.find(r => r.task.includes(word))
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

  test('run read-only: rust-reviewer on its own agent, every other on review-task with its body; on their tier\'s model', async () => {
    await batch()
    const rust = askedWith('TASK-RUST')
    assert.equal(rust.agent, 'rust-reviewer')
    assert.match(rust.prompt, /^Read the file .* it is your whole task/)
    const nix = askedWith('TASK-NIX')
    assert.equal(nix.agent, 'review-task')
    assert.ok(nix.prompt.indexOf('Read the file') > nix.prompt.indexOf('your whole task: use the guidance above'), 'the Claude Code agent\'s body first')
    assert.deepEqual(['rust', 'nix', 'gone', 'fail'].map(id => askedWith(BATCH.find(t => t.id === id)?.prompt ?? '').agent), ['rust-reviewer', 'review-task', 'review-task', 'review-task'])
    assert.deepEqual(['TASK-RUST', 'TASK-NIX', 'TASK-GONE'].map(w => askedWith(w).model), [
      { providerID: 'anthropic', modelID: 'claude-big' }, { providerID: 'anthropic', modelID: 'claude-small' }, undefined,
    ])
  })

  test('past their deadline are abandoned, a failed one handed out again, an agent with no body said degraded', async () => {
    await batch()
    const [first = []] = submits()
    assert.deepEqual(valuesOf(first, '--abandoned'), ['late'])
    assert.equal(asked.filter(r => r.task.includes('TASK FAIL')).length, 3, 'the first try and the binary\'s two retries')
    const degraded = valuesOf(first, '--degraded')
    assert.equal(degraded.length, 1)
    assert.match(String(degraded[0]), /no-such-agent/)
  })
})

test('a reply with no answer leaves none, and the binary asks again', async () => {
  await review([{ id: 'prose', prompt: 'PROSE', model: 'opus' }], '')
  assert.equal(asked.length, 3)
  assert.equal(fs.existsSync(path.join(at.run, 'answers', 'prose.json')), false)
})

test('a task on the usage limit starts no other, and the submit carries the limit', async () => {
  await review([{ id: 'a', prompt: 'LIMIT', model: 'opus' }, { id: 'b', prompt: 'TASK-B', model: 'opus' }], 'concurrency=1')
  assert.equal(asked.length, 1)
  assert.match(String(valuesOf(submits()[0] ?? [], '--limit')[0]), /hit your usage limit/)
})

test('arguments the driver cannot use are refused with nothing run, and a resume is the tool again', async () => {
  assert.match(await review([], 'languages=rust'), /INCOMPLETE — review cannot honour `languages`/)
  assert.match(await review([], 'concurrency=0'), /concurrency=0/)
  assert.match(await review([], 'opencodeModels=claude-big'), /opencodeModels/)
  assert.match(await review([], 'codexModels=x'), /INCOMPLETE/, 'the Codex driver\'s own name is not taken here')
  assert.equal(fs.existsSync(at.run), false)
  assert.equal(asked.length, 0)
})

test('an OpenCode without the rust-reviewer agent runs its tasks on review-task, and the submit says degraded', async () => {
  await review([{ id: 'rust', prompt: 'TASK-RUST', model: 'opus', agentType: 'rust-reviewer' }], '', new Set(['build', 'review-task']))
  assert.equal(askedWith('TASK-RUST').agent, 'review-task')
  assert.match(String(valuesOf(submits()[0] ?? [], '--degraded')[0]), /`rust-reviewer`, an agent this OpenCode does not have/)
})

test('an OpenCode without the review-task agent is refused up front: no session, no run, never a writable agent', async () => {
  const answer = await review(BATCH, '', new Set(['build', 'rust-reviewer']))
  assert.match(answer, /^## Verdict\n\n\S* ?INCOMPLETE — the craft OpenCode agents are not installed or are out of date: rerun integrations\/opencode\/install\.sh/)
  assert.equal(asked.length, 0)
  assert.equal(fs.existsSync(at.run), false, 'the binary was never asked')
})

test('an empty agent list is no evidence: a 2.x answering before its instance loaded does not refuse a correct install', async () => {
  const answer = await review([{ id: 'nix', prompt: 'TASK-NIX', model: 'haiku', agentType: 'nix-reviewer' }], '', new Set())
  assert.doesNotMatch(answer, /not installed or are out of date/)
  assert.equal(askedWith('TASK-NIX').agent, 'review-task')
})
