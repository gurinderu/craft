// The Codex review driver end to end over a fake `craft` and a fake `codex` (lib/codex-review-fakes.mjs): one step's
// tasks run as parallel codex processes up to the limit, each with its agent's prompt body first and its tier's
// model, the failed and the late ones abandoned, the usage limit stopping the rest, and the binary's answer printed.
import { afterEach, beforeEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './codex-review.mjs'
import { FAKE_CODEX, FAKE_CRAFT, writeExecutable } from './codex-review-fakes.mjs'

/** @type {string} */
let dir
/** @type {{ craft: string, codex: string, run: string, log: string, repo: string }} */
let at

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-codex-review-')))
  at = { craft: path.join(dir, 'craft'), codex: path.join(dir, 'codex'), run: path.join(dir, 'run'), log: path.join(dir, 'log'), repo: path.join(dir, 'repo') }
  for (const d of [at.log, at.repo]) fs.mkdirSync(d)
  writeExecutable(at.craft, FAKE_CRAFT)
  writeExecutable(at.codex, FAKE_CODEX)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** @param {Array<{ id: string, prompt: string, model: string, agentType?: string }>} tasks @param {string[]} args */
function review(tasks, args, env = {}) {
  const e = { PATH: process.env['PATH'], HOME: dir, FAKE_RUN: at.run, FAKE_LOG: at.log, FAKE_TASKS: JSON.stringify(tasks), CRAFT_CODEX_BIN: at.codex, ...env }
  return run([`craftBin=${at.craft}`, `repo=${at.repo}`, ...args], e, { deadlineMs: () => 2000 })
}

/** Each codex call the fake logged. @returns {Array<{ argv: string[], stdin: string, alive: number, cwd: string, root: string }>} */
const calls = () => fs.readdirSync(at.log).filter(f => f.startsWith('call-')).map(f => JSON.parse(fs.readFileSync(path.join(at.log, f), 'utf8')))
/** The call whose prompt holds `word`. @param {string} word */
function callWith(word) {
  const call = calls().find(c => c.stdin.includes(word))
  assert.ok(call, `no codex call for ${word}`)
  return call
}
/** The first submit's argv. @returns {string[]} */
const firstSubmit = () => JSON.parse(String(fs.readFileSync(path.join(at.run, 'submits.jsonl'), 'utf8').split('\n')[0]))
/** The values each `flag` of a submit carried. @param {string[]} argv @param {string} flag */
const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []))

const BATCH = [
  { id: 'rust', prompt: 'TASK-RUST', model: 'opus', agentType: 'rust-reviewer' },
  { id: 'plain', prompt: 'TASK-PLAIN', model: 'haiku' },
  { id: 'gone', prompt: 'TASK-GONE', model: 'sonnet', agentType: 'no-such-agent' },
  { id: 'fail', prompt: 'TASK FAIL', model: 'sonnet' },
  { id: 'late', prompt: 'TASK HANG', model: 'sonnet' },
]
const ROOT = path.resolve(import.meta.dirname, '..')
/** One batch reviewed with two at once and a model for opus and haiku. */
const batch = () => review(BATCH, ['concurrency=2', 'codexModels=opus=gpt-big,haiku=gpt-small'])

describe('a step\'s tasks', () => {
  test('run as codex processes in parallel up to the limit, each read-only in the repo, its answer to the task\'s file', async () => {
    assert.equal((await batch()).exitCode, 0)
    const all = calls()
    assert.deepEqual([all.length, Math.max(...all.map(c => c.alive))], [5, 2], 'two at once, never more')
    const argv = callWith('TASK-RUST').argv
    assert.deepEqual(argv.slice(0, 4), ['exec', '--ephemeral', '-s', 'read-only'])
    assert.deepEqual([valuesOf(argv, '-o')[0], valuesOf(argv, '-C')[0], argv.at(-1)], [path.join(at.run, 'answers', 'rust.json'), at.repo, '-'])
    assert.match(String(valuesOf(argv, '--output-schema')[0]), /rust\.codex\.schema\.json$/, 'the optional field needs a strict copy')
    assert.equal(callWith('TASK-RUST').root, ROOT, 'the prompts\' plugin root is this plugin')
    const answered = new Map(JSON.parse(fs.readFileSync(path.join(at.run, 'answered.json'), 'utf8')))
    assert.deepEqual(JSON.parse(String(answered.get('rust.json'))), { answer: 'ok' }, 'the null the strict copy forced is dropped')
  })

  test('run with their agent\'s prompt body first and their tier\'s model, the session\'s for a tier not mapped', async () => {
    await batch()
    const rust = callWith('TASK-RUST')
    assert.match(rust.stdin, /^You are a senior Rust reviewer/)
    assert.ok(rust.stdin.indexOf('TASK-RUST') > rust.stdin.indexOf('your whole task'))
    assert.doesNotMatch(callWith('TASK-PLAIN').stdin, /senior Rust reviewer/)
    assert.deepEqual(['TASK-RUST', 'TASK-PLAIN', 'TASK-GONE'].map(w => valuesOf(callWith(w).argv, '-m')), [['gpt-big'], ['gpt-small'], []])
  })

  test('failed or past their deadline are abandoned, an agent with no body said degraded, and the answer printed', async () => {
    const got = await batch()
    const submit = firstSubmit()
    assert.deepEqual(valuesOf(submit, '--abandoned').sort(), ['fail', 'late'])
    assert.deepEqual(valuesOf(submit, '--agents'), ['5'])
    const degraded = valuesOf(submit, '--degraded')
    assert.equal(degraded.length, 1)
    assert.match(String(degraded[0]), /no-such-agent/)
    const out = got.stdout.join('\n')
    assert.match(out, /^## Verdict\n\n✅ Approve — fake review/)
    assert.match(out, /- \[High\] src\/a\.rs:3 — a fake finding \(confirmed\)/)
    assert.deepEqual(valuesOf(JSON.parse(fs.readFileSync(path.join(at.run, 'start.json'), 'utf8')), '--record-root'), [ROOT])
  })
})

test('a task on the usage limit starts no other, and the submit carries the limit', async () => {
  const tasks = [{ id: 'a', prompt: 'LIMIT', model: 'opus' }, { id: 'b', prompt: 'TASK-B', model: 'opus' }]
  const got = await review(tasks, ['concurrency=1'])
  assert.equal(got.exitCode, 0)
  assert.equal(calls().length, 1)
  const submit = firstSubmit()
  assert.match(String(valuesOf(submit, '--limit')[0]), /hit your usage limit/)
  assert.deepEqual(valuesOf(submit, '--abandoned'), [], 'the limit is no failure of the task')
})

test('an argument the review does not take is refused with nothing run', async () => {
  const got = await review([], ['languages=rust'])
  assert.equal(got.exitCode, 2)
  assert.match(got.stdout.join('\n'), /INCOMPLETE — review cannot honour `languages`/)
  assert.equal(fs.existsSync(at.run), false)
  assert.equal((await review([], ['concurrency=0'])).exitCode, 2)
  assert.equal((await review([], ['codexModels=gpt=x'])).exitCode, 2)
})
