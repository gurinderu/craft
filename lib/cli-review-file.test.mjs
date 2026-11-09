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

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

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
    return { exitCode: r.exitCode, answer: JSON.parse(String(r.stdout.at(-1) ?? 'null')) }
  }
  return { repo, store, ask }
}

const STEP = { run: '/tmp/run-f', done: true, report: '/tmp/run-f/report.md', verdict: 'Approve', line: 'Approve', findings: [] }

test('a checkpoint after a step that ended no phase writes nothing', async () => {
  const { store, ask } = setup()
  const steps = [{ done: false, phase: 'lenses', at: 1, took: 1, agents: 0 }, { done: false, phase: 'lenses', at: 2, took: 1, agents: 1 }]
  assert.deepEqual((await ask('checkpoint', { start: false, steps })).answer, { skipped: true })
  assert.deepEqual(fs.readdirSync(store), [])
})

test('the record re-sent as a retry is answered already filed, never filed twice', async () => {
  const { store, ask } = setup()
  const first = await ask('finalize', { step: STEP, retry: false, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  assert.deepEqual(first.answer, { ok: true, reason: '' })
  const again = await ask('finalize', { step: STEP, retry: true, steps: [{ done: true, phase: '', at: 1, took: 1, agents: 0 }] })
  assert.equal(again.answer.ok, true)
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').length, 1, 'one record in the store')
})

test('a finished step it cannot read is a failed record, said; an input it cannot read and an unknown command are refused', async () => {
  const { ask } = setup()
  assert.deepEqual((await ask('finalize', { step: { done: true } })).answer, { ok: false, reason: 'the finished step cannot be read: a finished step names no report or verdict' })
  assert.equal((await run(['finalize', '--input', '/nonexistent/in.json'])).exitCode, 1)
  assert.equal((await run(['write'])).exitCode, 2)
})
