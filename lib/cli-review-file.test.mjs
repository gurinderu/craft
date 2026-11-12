// The run-record adapter the craft binary runs (lib/cli-review-file.mjs): its answer is the last stdout line, a
// checkpoint of no ended phase writes nothing, a record re-sent as a retry is answered `already filed` rather than
// filed twice, and an input it cannot read or a command it does not know is refused by exit code.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './cli-review-file.mjs'
import { recoverPartials } from './craft-log-run.mjs'

/** @type {string[]} */
const made = []
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

/** A one-commit repository, a store, and the adapter run over a request in it. */
function setup() {
  const repo = tmp('craft-file-repo-')
  const store = tmp('craft-file-store-')
  /** @param {string[]} a */
  const git = a => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' })
  git(['init', '-q', '-b', 'feat/x'])
  fs.writeFileSync(path.join(repo, 'a.rs'), 'fn a() {}\n')
  git(['add', 'a.rs'])
  git(['commit', '-q', '-m', 'a'])
  /** @param {string} command @param {Record<string, unknown>} req */
  const ask = async (command, req) => {
    const input = path.join(store, '..', `${path.basename(store)}-in.json`)
    made.push(input)
    fs.writeFileSync(input, JSON.stringify({ repo, craftVersion: '0.44.0', session: '', dir: '', rejoin: false, steps: [], head: '', ...req }))
    const r = await run([command, '--input', input, '--store', store])
    return { exitCode: r.exitCode, answer: JSON.parse(r.stdout.at(-1) ?? 'null') }
  }
  return { repo, store, ask }
}

const STEP = { run: '/tmp/run-f', done: true, report: '/tmp/run-f/report.md', verdict: 'Approve', line: 'Approve', findings: [] }

test('a checkpoint after a step that ended no phase writes nothing', async () => {
  const { store, ask } = setup()
  const steps = [
    { done: false, phase: 'lenses', at: 1, took: 1, agents: 0 },
    { done: false, phase: 'lenses', at: 2, took: 1, agents: 1 },
  ]
  assert.deepEqual((await ask('checkpoint', { start: false, steps })).answer, { skipped: true })
  assert.deepEqual(fs.readdirSync(store), [])
})

test('the record re-sent as a retry is answered already filed, never filed twice', async () => {
  const { store, ask } = setup()
  const first = await ask('finalize', { step: STEP, retry: false, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  const filed = path.join(store, String(fs.readdirSync(store).find(f => f.endsWith('.json'))))
  assert.deepEqual(first.answer, { ok: true, reason: '', file: filed }, "it names the record file, which the run's cost is enriched into")
  const again = await ask('finalize', { step: STEP, retry: true, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  assert.deepEqual([again.answer.ok, again.answer.file], [true, filed], 'the retry names the file the first filed')
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1, 'one record in the store')
})

test('the record names the host its tasks ran in: the backend the binary sent, else claude-code', async () => {
  const told = [{ done: true, phase: '', at: 1, took: 1, agents: 0 }]
  for (const [runtime, want] of [
    ['codex', 'codex'],
    ['', 'claude-code'],
    [undefined, 'claude-code'],
  ]) {
    const { ask } = setup()
    const r = await ask('finalize', { step: STEP, retry: false, steps: told, ...(runtime === undefined ? {} : { runtime }) })
    assert.equal(r.answer.ok, true, r.answer.reason)
    assert.equal(JSON.parse(fs.readFileSync(r.answer.file, 'utf8')).runtime, want, String(runtime))
  }
})

test('a checkpoint carries the host its tasks ran in, and a run recovered from its checkpoints is filed under it', async () => {
  for (const [runtime, want] of [
    ['codex', 'codex'],
    ['', 'claude-code'],
  ]) {
    const { repo, store, ask } = setup()
    const r = await ask('checkpoint', { start: true, runtime })
    const runDir = String(r.answer.runDir)
    const slice = JSON.parse(fs.readFileSync(path.join(runDir, fs.readdirSync(runDir).find(f => f.endsWith('.json')) ?? ''), 'utf8'))
    assert.equal(slice.runtime, runtime || undefined, `the checkpoint, ${want}`)
    const [o] = recoverPartials({ store, project: repo, now: new Date(Date.now() + 7 * 60 * 60 * 1000), force: true })
    assert.ok(o, 'the dead run is recovered')
    assert.equal(JSON.parse(fs.readFileSync(o.file, 'utf8')).runtime, want, `the recovered record, ${want}`)
  }
})

test('a finished step it cannot read is a failed record, said; an input it cannot read and an unknown command are refused', async () => {
  const { ask } = setup()
  assert.deepEqual((await ask('finalize', { step: { done: true } })).answer, {
    ok: false,
    reason: 'the finished step cannot be read: a finished step names no report or verdict',
  })
  assert.equal((await run(['finalize', '--input', '/nonexistent/in.json'])).exitCode, 1)
  assert.equal((await run(['write'])).exitCode, 2)
})

test('a finished run is filed after its reviewed worktree was removed', async () => {
  const { repo, store, ask } = setup()
  fs.rmSync(repo, { recursive: true, force: true })
  const filed = await ask('finalize', { step: STEP, retry: true, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  assert.deepEqual([filed.exitCode, filed.answer.ok], [0, true], JSON.stringify(filed.answer))
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1, 'one record in the store')
})

test('a record re-filed after its linked worktree was removed is keyed as one filed while it existed', async () => {
  const main = tmp('craft-file-main-')
  /** @param {string[]} a @param {string} [cwd] */
  const git = (a, cwd = main) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).stdout.trim()
  git(['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(main, 'a.rs'), 'fn a() {}\n')
  git(['add', 'a.rs'])
  git(['commit', '-q', '-m', 'a'])
  const wt = path.join(tmp('craft-file-wts-'), 'review-1')
  git(['worktree', 'add', '-q', '-b', 'feat/x', wt])
  fs.writeFileSync(path.join(wt, 'b.rs'), 'fn b() {}\n')
  git(['add', 'b.rs'], wt)
  git(['commit', '-q', '-m', 'b'], wt)
  // What the binary keeps of the run when it starts (cli/crates/craft-review/src/filing/kept.rs, Ctx).
  const req = {
    repo: wt,
    craftVersion: '0.45.0',
    session: '',
    dir: '',
    rejoin: false,
    retry: false,
    step: STEP,
    steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }],
    head: git(['rev-parse', 'HEAD'], wt),
    gitDir: git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt),
    branch: 'feat/x',
    dirty: false,
  }
  /** @param {string} store @param {boolean} [retry] */
  const fileInto = async (store, retry = false) => {
    const input = path.join(tmp('craft-file-in-'), 'in.json')
    fs.writeFileSync(input, JSON.stringify({ ...req, retry }))
    const r = await run(['finalize', '--input', input, '--store', store])
    const answer = JSON.parse(String(r.stdout.at(-1)))
    assert.equal(answer.ok, true, JSON.stringify(answer))
    const rec = JSON.parse(fs.readFileSync(answer.file, 'utf8'))
    return { project: rec.project, branch: rec.branch, head: rec.head, commit: rec.commit, dirty: rec.dirty }
  }
  const live = await fileInto(tmp('craft-file-store-'))
  assert.deepEqual([live.project, live.branch, live.head], [main, 'feat/x', req.head], 'the live run keys to the main checkout')
  fs.writeFileSync(path.join(wt, 'c.rs'), 'fn c() {}\n')
  git(['add', 'c.rs'], wt)
  git(['commit', '-q', '-m', 'c'], wt)
  fs.writeFileSync(path.join(wt, 'b.rs'), 'fn b2() {}\n')
  assert.deepEqual(await fileInto(tmp('craft-file-store-'), true), live, 'a re-file over a checkout moved on since files the run as it ran')
  fs.rmSync(wt, { recursive: true, force: true })
  assert.deepEqual(await fileInto(tmp('craft-file-store-')), live, 'and so does any filing once the worktree is gone')
  const store = tmp('craft-file-store-')
  const input = path.join(tmp('craft-file-in-'), 'in.json')
  fs.writeFileSync(input, JSON.stringify({ ...req, start: true }))
  const answer = JSON.parse(String((await run(['checkpoint', '--input', input, '--store', store])).stdout.at(-1)))
  const slice = JSON.parse(fs.readFileSync(path.join(answer.runDir, fs.readdirSync(answer.runDir).find(f => f.endsWith('.json')) ?? ''), 'utf8'))
  assert.deepEqual(
    [slice.project, slice.branch, slice.head],
    [main, 'feat/x', req.head],
    'a checkpoint after the worktree is gone carries the identity its ownership proof is read from',
  )
})

test('a publication after the fact writes the sorting and the posting into the record already filed, keeping choices', async () => {
  const { store, ask } = setup()
  const first = await ask('finalize', { step: STEP, retry: false, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  const file = first.answer.file
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sorting, null, 'a run without comment files no sorting')
  const sorting = { defect: 1, doubtful: 1, inDiffJudged: true, findings: [{ n: 1, title: 'g leaks', file: 'a.rs', line: 9 }] }
  const prComments = { pr: 7, url: 'u', requested: 1, posted: 1, already: 0, failed: 0, noFile: 0, reason: 'PR #7 u', error: '' }
  const published = { ...STEP, sorting, prComments, memoryContradictions: { count: 0, inDiffJudged: true, findings: [] } }
  const said = await ask('publication', { step: published, recordFile: file })
  assert.deepEqual(said.answer, { ok: true, reason: '', file })
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([rec.sorting, rec.prComments, rec.memoryContradictions.count], [sorting, prComments, 0])
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1, 'still one record in the store')
  fs.writeFileSync(file, JSON.stringify({ ...rec, sorting: { ...sorting, choices: { 1: { choice: 'question' } } } }))
  await ask('publication', { step: { ...published, prComments: { ...prComments, posted: 0, already: 1 } }, recordFile: file })
  const again = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([again.sorting.choices, again.prComments.already], [{ 1: { choice: 'question' } }, 1], "the reviewer's choices stay")
})

test('a publication with no record file, or over one that cannot be read, is a failure said', async () => {
  const { ask } = setup()
  assert.deepEqual((await ask('publication', { step: STEP })).answer, { ok: false, reason: 'no record file was named', file: '' })
  const missing = (await ask('publication', { step: STEP, recordFile: '/nonexistent/r.json' })).answer
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /record not readable at \/nonexistent\/r\.json/)
})
