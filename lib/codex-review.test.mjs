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
/** @type {{ craft: string, codex: string, run: string, log: string, repo: string, store: string }} */
let at

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-codex-review-')))
  at = { craft: path.join(dir, 'craft'), codex: path.join(dir, 'codex'), run: path.join(dir, 'run'), log: path.join(dir, 'log'), repo: path.join(dir, 'repo'), store: path.join(dir, 'store') }
  for (const d of [at.log, at.repo]) fs.mkdirSync(d)
  writeExecutable(at.craft, FAKE_CRAFT)
  writeExecutable(at.codex, FAKE_CODEX)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** @param {Array<{ id: string, prompt: string, model: string, agentType?: string }>} tasks @param {string[]} args */
function review(tasks, args, env = {}) {
  return reviewBare(tasks, [`craftBin=${at.craft}`, `repo=${at.repo}`, ...args], env)
}
/** As the skill runs it by default: no repo= (the session's checkout, here the test's repo directory). @param {Array<{ id: string, prompt: string, model: string, agentType?: string }>} tasks @param {string[]} args @param {Record<string, string>} [env] @param {import('./codex-review.mjs').Deps} [deps] */
function reviewBare(tasks, args, env = {}, deps = {}) {
  const e = { PATH: process.env['PATH'], HOME: dir, FAKE_RUN: at.run, FAKE_LOG: at.log, FAKE_TASKS: JSON.stringify(tasks), CRAFT_CODEX_BIN: at.codex, ...env }
  return run(args, e, { deadlineMs: () => 2000, store: at.store, cwd: at.repo, ...deps })
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
    assert.deepEqual([all.length, Math.max(...all.map(c => c.alive))], [7, 2], 'five, then the failed one twice again; two at once, never more')
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

  test('past their deadline are abandoned, a failed one handed out again, an agent with no body said degraded, and the answer printed', async () => {
    const got = await batch()
    const submit = firstSubmit()
    assert.deepEqual(valuesOf(submit, '--abandoned'), ['late'], 'a failure is no abandonment: the binary retries it')
    assert.equal(calls().filter(c => c.stdin.includes('TASK FAIL')).length, 3, 'the first try and the binary\'s two retries')
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

test('a task that fails once is handed out again by the binary and its retry answers', async () => {
  const got = await review([{ id: 'flaky', prompt: 'TASK FAIL-ONCE', model: 'opus' }], [])
  assert.equal(got.exitCode, 0)
  const all = fs.readFileSync(path.join(at.run, 'submits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(all.length, 2, 'one submit after the failure, one after the retry')
  assert.deepEqual(all.map(s => valuesOf(s, '--abandoned')), [[], []])
  assert.equal(calls().length, 2)
  const answered = new Map(JSON.parse(fs.readFileSync(path.join(at.run, 'answered.json'), 'utf8')))
  assert.deepEqual(JSON.parse(String(answered.get('flaky.json'))), { answer: 'ok' })
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

/** The records the driver filed into the test's store. @returns {Array<Record<string, any>>} */
const filed = () => (fs.existsSync(at.store) ? fs.readdirSync(at.store).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(at.store, f), 'utf8'))) : [])

describe('the run\'s telemetry', () => {
  test('a refused argument files the engines\' refusal record, with its class in notRun', async () => {
    await review([], ['languages=rust'])
    const [record] = filed()
    assert.equal(record?.['verdict'], 'INCOMPLETE (argument refused)')
    assert.equal(record?.['driver'], 'cli')
    assert.deepEqual(record?.['notRun'], ['an argument the engine does not take was refused, nothing ran'])
  })

  test('a run the binary never finished is filed INCOMPLETE by the driver and said stopped', async () => {
    const got = await review([{ id: 'a', prompt: 'TASK-A', model: 'opus' }], [], { FAKE_BROKEN: '1' })
    assert.equal(got.exitCode, 1)
    assert.match(got.stdout.join('\n'), /INCOMPLETE — review stopped: the command exited 1/)
    const [record] = filed()
    assert.deepEqual([record?.['verdict'], record?.['notRun'], record?.['runtimeStats']?.agents], ['INCOMPLETE', ['the craft binary did not finish the run'], 1])
  })

  test('a telemetry write the binary could not land is said in the answer, with how to file it again', async () => {
    const got = await review([{ id: 'a', prompt: 'TASK-A', model: 'opus' }], [], { FAKE_FILING: JSON.stringify({ runDir: '', rejoin: false, lost: ['the record — disk full'], record: 'failed' }) })
    const out = got.stdout.join('\n')
    assert.match(out, /## ⚠️ Telemetry lost/)
    assert.match(out, /the record — disk full/)
    assert.match(out, /The run record can be filed again: this driver again, `node .*codex-review\.mjs run=/)
    assert.deepEqual(filed(), [], 'a run the binary finished is never filed by the driver')
  })

  test('a filed record leaves the answer without a telemetry section', async () => {
    const got = await review([{ id: 'a', prompt: 'TASK-A', model: 'opus' }], [], { FAKE_FILING: JSON.stringify({ runDir: '', rejoin: false, lost: [], record: 'filed' }) })
    assert.doesNotMatch(got.stdout.join('\n'), /Telemetry/)
  })

  test('a fresh run with no repo= that the binary never finished is filed under the session\'s checkout', async () => {
    const got = await reviewBare([{ id: 'a', prompt: 'TASK-A', model: 'opus' }], [`craftBin=${at.craft}`], { FAKE_BROKEN: '1' })
    assert.equal(got.exitCode, 1)
    assert.doesNotMatch(got.stdout.join('\n'), /resumed run/)
    const [record] = filed()
    assert.equal(record?.['verdict'], 'INCOMPLETE')
    assert.equal(record?.['project'], at.repo)
  })

  test('a resume with no repo= whose binary cannot be got files nothing and says why; with repo= it is filed', async () => {
    const fail = { ensureBin: async () => { throw new Error('offline') } }
    const bare = await reviewBare([], [`run=${at.run}`], {}, fail)
    assert.equal(bare.exitCode, 1)
    assert.match(bare.stdout.join('\n'), /could not get the craft binary[\s\S]*No run record was filed: the resumed run's repository is unknown/)
    assert.deepEqual(filed(), [])
    const keyed = await reviewBare([], [`run=${at.run}`, `repo=${at.repo}`], {}, fail)
    assert.doesNotMatch(keyed.stdout.join('\n'), /No run record was filed/)
    assert.equal(filed()[0]?.['verdict'], 'INCOMPLETE')
  })
})
