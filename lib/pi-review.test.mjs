// The pi review driver end to end over a fake `craft` and a fake `pi` (lib/pi-review-fakes.mjs): a step's tasks run
// as parallel pi processes up to the limit, each with its agent's prompt body first and its tier's model when the
// table maps one, the failed and the late ones abandoned, the usage limit stopping the rest, the next step after the
// submit, and the binary's answer printed.
import { afterEach, beforeEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './pi-review.mjs'
import { taskMessage } from './pi-review-task.mjs'
import { FAKE_CRAFT, FAKE_PI, writeExecutable } from './pi-review-fakes.mjs'

/** @type {string} */
let dir
/** @type {{ craft: string, pi: string, run: string, log: string, repo: string }} */
let at

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pi-review-')))
  at = { craft: path.join(dir, 'craft'), pi: path.join(dir, 'pi'), run: path.join(dir, 'run'), log: path.join(dir, 'log'), repo: path.join(dir, 'repo') }
  for (const d of [at.log, at.repo]) fs.mkdirSync(d)
  writeExecutable(at.craft, FAKE_CRAFT)
  writeExecutable(at.pi, FAKE_PI)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** @typedef {{ id: string, prompt: string, model: string, agentType?: string }} FakeTask */
/** @param {FakeTask[][]} steps @param {string[]} args @param {Record<string, string>} [env] */
function review(steps, args, env = {}) {
  const e = { PATH: process.env['PATH'], HOME: dir, FAKE_RUN: at.run, FAKE_LOG: at.log, FAKE_STEPS: JSON.stringify(steps), CRAFT_PI_BIN: at.pi, ...env }
  return run([`craftBin=${at.craft}`, `repo=${at.repo}`, ...args], e, { deadlineMs: () => 2000 })
}

/** Each pi call the fake logged. @returns {Array<{ argv: string[], message: string, prompt: string, alive: number, cwd: string, root: string }>} */
const calls = () => fs.readdirSync(at.log).filter(f => f.startsWith('call-')).map(f => JSON.parse(fs.readFileSync(path.join(at.log, f), 'utf8')))
/** The call whose task prompt holds `word`. @param {string} word */
function callWith(word) {
  const call = calls().find(c => c.prompt.includes(word))
  assert.ok(call, `no pi call for ${word}`)
  return call
}
/** Each submit's argv and the answer files it found. @returns {Array<{ argv: string[], answered: string[] }>} */
const submits = () => fs.readFileSync(path.join(at.run, 'submits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
/** The values each `flag` carried. @param {string[]} argv @param {string} flag */
const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

const BATCH = [
  { id: 'rust', prompt: 'TASK-RUST', model: 'opus', agentType: 'rust-reviewer' },
  { id: 'plain', prompt: 'TASK-PLAIN', model: 'haiku' },
  { id: 'gone', prompt: 'TASK-GONE', model: 'sonnet', agentType: 'no-such-agent' },
  { id: 'fail', prompt: 'TASK FAIL', model: 'sonnet' },
  { id: 'late', prompt: 'TASK HANG', model: 'sonnet' },
  { id: 'quiet', prompt: 'TASK SILENT', model: 'sonnet' },
]
const ROOT = path.resolve(import.meta.dirname, '..')
/** One batch, then a second step, reviewed two at once with a pi model for opus and haiku. */
const batch = () => review([BATCH, [{ id: 'next', prompt: 'TASK-NEXT', model: 'opus' }]], ['concurrency=2', 'piModels=opus=anthropic/claude-opus-4-5,haiku=small:low'])

describe('a step\'s tasks', () => {
  test('run as pi processes in parallel up to the limit, in the repo, each its own print-mode session', async () => {
    assert.equal((await batch()).exitCode, 0)
    const all = calls()
    assert.deepEqual([all.length, Math.max(...all.map(c => c.alive))], [7, 2], 'two at once, never more')
    const call = callWith('TASK-RUST')
    assert.deepEqual(call.argv.slice(0, 10), ['-p', '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-approve', '--no-extensions', '--no-mcp', '--tools', 'read,bash,grep,find,ls'])
    assert.ok(!call.argv.some(a => /\b(write|edit)\b/.test(a) && a.startsWith('read,')), 'no tool that writes or edits a file')
    assert.deepEqual([call.argv.at(-2), call.cwd, call.root], ['--', at.repo, ROOT])
    assert.match(call.message, /print your answer as one JSON object at the end of your reply, in a ```json fenced block, matching the schema in \S+rust\.schema\.json\. Do not write or change any file\./)
    assert.equal(fs.readFileSync(path.join(at.run, 'answers', 'next.json'), 'utf8'), '{"answer":"ok"}\n', 'the fenced block pi printed, written by the driver')
  })

  test('run with their agent\'s prompt body first, and their tier\'s model only when the table maps it', async () => {
    await batch()
    const rust = callWith('TASK-RUST').message
    assert.match(rust, /^You are a senior Rust reviewer/)
    assert.ok(rust.indexOf('Read the file') > rust.indexOf('your whole task'))
    assert.match(callWith('TASK-PLAIN').message, /^Read the file /)
    assert.deepEqual(['TASK-RUST', 'TASK-PLAIN', 'TASK-GONE'].map(w => valuesOf(callWith(w).argv, '--model')), [['anthropic/claude-opus-4-5'], ['small:low'], []])
  })

  test('late ones are abandoned, failed or unanswered ones left to the binary, an agent with no body said degraded', async () => {
    await batch()
    const [first, second] = submits()
    assert.ok(first && second)
    assert.deepEqual(valuesOf(first.argv, '--abandoned'), ['late'])
    assert.deepEqual(first.answered, ['gone.json', 'plain.json', 'rust.json'])
    assert.deepEqual([valuesOf(first.argv, '--agents'), valuesOf(second.argv, '--agents')], [['6'], ['7']])
    const degraded = valuesOf(first.argv, '--degraded')
    assert.equal(degraded.length, 1)
    assert.match(String(degraded[0]), /`no-such-agent`, whose prompt body the pi driver did not find/)
  })
})

test('the final report is the binary\'s answer, and the start is filed through this package', async () => {
  const got = await review([[{ id: 'a', prompt: 'TASK-A', model: 'opus' }]], [])
  assert.equal(got.exitCode, 0)
  assert.deepEqual(valuesOf(calls()[0]?.argv ?? [], '--model'), [], 'no table: pi\'s own model')
  const out = got.stdout.join('\n')
  assert.match(out, /^## Verdict\n\n✅ Approve — fake review/)
  assert.match(out, /- \[High\] src\/a\.rs:3 — a fake finding \(confirmed\)/)
  assert.deepEqual(valuesOf(JSON.parse(fs.readFileSync(path.join(at.run, 'start.json'), 'utf8')), '--record-root'), [ROOT])
  assert.match(got.stderr.join('\n'), /review \S+ in pi: .* up to 4 task\(s\) at once/)
})

test('a task on the usage limit starts no other, and the submit carries the limit', async () => {
  const tasks = [{ id: 'a', prompt: 'LIMIT', model: 'opus' }, { id: 'b', prompt: 'TASK-B', model: 'opus' }]
  assert.equal((await review([tasks], ['concurrency=1'])).exitCode, 0)
  assert.equal(calls().length, 1)
  const [submit] = submits()
  assert.match(String(valuesOf(submit?.argv ?? [], '--limit')[0]), /hit your usage limit/)
  assert.deepEqual(valuesOf(submit?.argv ?? [], '--abandoned'), [], 'the limit is no failure of the task')
})

test('an answer printed as a bare object after prose with braces in it is the last object that parses', async () => {
  await review([[{ id: 'p', prompt: 'TASK PROSE', model: 'opus' }]], [])
  const [submit] = submits()
  assert.deepEqual(submit?.answered, ['p.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(at.run, 'answers', 'p.json'), 'utf8')), { answer: 'prose {ok}', n: 2 })
})

test('a task that finds pi not logged in starts no other and stops the run before the submit, naming it to resume', async () => {
  const tasks = [{ id: 'a', prompt: 'NOLOGIN', model: 'opus' }, { id: 'b', prompt: 'TASK-B', model: 'opus' }]
  const got = await review([tasks], ['concurrency=1'])
  assert.equal(got.exitCode, 1)
  assert.equal(calls().length, 1)
  assert.equal(fs.existsSync(path.join(at.run, 'submits.jsonl')), false)
  const out = got.stdout.join('\n')
  assert.match(out, /INCOMPLETE — pi is not logged in \(No API key found for the selected model\.\): log in to pi/)
  assert.ok(out.includes(`The run is in ${at.run}.`) && out.includes(`pi-review.mjs run=${at.run}`), out)
})

test('a prompt that names craft\'s files under CLAUDE_PLUGIN_ROOT is read from a copy with the root written in', async () => {
  await review([[{ id: 'r', prompt: 'TASK-ROOT read ${CLAUDE_PLUGIN_ROOT}/content/x.md', model: 'opus' }]], [])
  const call = callWith('TASK-ROOT')
  assert.match(call.message, /Read the file \S+r\.pi\.md and/)
  assert.equal(call.prompt, `TASK-ROOT read ${ROOT}/content/x.md`)
})

test('the task message names where craft\'s skills are and spells the plugin root out', () => {
  const t = { id: 'x', label: 'x', model: 'opus', promptFile: '/r/tasks/x.md', schemaFile: '/r/tasks/x.schema.json', answerFile: '/r/answers/x.json' }
  const msg = taskMessage('Load ${CLAUDE_PLUGIN_ROOT}/content/a.md first.', t, '/pkg')
  assert.match(msg, /^Load \/pkg\/content\/a\.md first\./)
  assert.ok(msg.endsWith('is the file /pkg/skills/<name>/SKILL.md: read it from there.'))
  assert.doesNotMatch(msg, /CLAUDE_PLUGIN_ROOT/)
})

test('the model table may come from the environment, and a bad argument is refused with nothing run', async () => {
  await review([[{ id: 'a', prompt: 'TASK-A', model: 'haiku' }]], [], { CRAFT_PI_MODELS: 'tiny' })
  assert.deepEqual(valuesOf(calls()[0]?.argv ?? [], '--model'), ['tiny'])
  fs.rmSync(at.run, { recursive: true })
  const got = await review([], ['languages=rust'])
  assert.equal(got.exitCode, 2)
  assert.match(got.stdout.join('\n'), /INCOMPLETE — review cannot honour `languages`/)
  assert.equal(fs.existsSync(at.run), false)
  assert.equal((await review([], ['concurrency=0'])).exitCode, 2)
  assert.equal((await review([], ['piModels=gpt=x'])).exitCode, 2)
})
