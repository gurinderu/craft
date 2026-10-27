// The command line of lib/mutation-issue.mjs, through its `run` (realm @nick/craft, #172), with the real
// spawn of `gh`: a stand-in `gh` on the PATH that `run`'s environment carries records each argv it gets.
import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './mutation-issue.mjs'

const RUN = 'https://github.com/o/r/actions/runs/1'

/**
 * A directory holding an executable `gh` that appends its argv to a log, prints `listing` for `issue list`,
 * `jobs` for `run view`, and exits with `exit`.
 * @param {string} listing @param {number} [exit] @param {string} [jobs]
 * @returns {{ env: NodeJS.ProcessEnv, calls: () => string[][] }}
 */
function ghOnPath(listing, exit = 0, jobs = '{}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-fake-gh-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'calls.jsonl')
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[3] === 'list') process.stdout.write(${JSON.stringify(listing)})
if (process.argv[3] === 'view') process.stdout.write(${JSON.stringify(jobs)})
process.exit(${String(exit)})
`, { mode: 0o755 })
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => /** @type {string[]} */ (JSON.parse(l))) : [])
  return { env: { PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}` }, calls }
}

test('run: no report argument and no RUN_URL still report the red run, as "no report" and "(run link missing)"', async () => {
  const { env, calls } = ghOnPath('[]')
  const r = await run([], env)
  assert.deepEqual(r, { exitCode: 0, stdout: ['created: Weekly mutation run failed (no report)'], stderr: [] })
  const create = calls()[1] ?? []
  assert.deepEqual(create.slice(0, 4), ['issue', 'create', '--title', 'Weekly mutation run failed (no report)'])
  assert.match(create[5] ?? '', /^The weekly mutation run failed: \(run link missing\)\n/)
})

test('run: with an open issue it comments there, with the run link from RUN_URL', async () => {
  const { env, calls } = ghOnPath('[{"number":7,"title":"Weekly mutation run failed (65.10%)"}]')
  const r = await run([path.join(os.tmpdir(), 'craft-no-such-report.json')], { ...env, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 0, stdout: ['commented on #7'], stderr: [] })
  assert.deepEqual(calls()[1], ['issue', 'comment', '7', '--body', `Failed again: ${RUN}\n\nScore: no report.`])
})

test('run: a gh that fails exits 1 naming the gh command, and nothing is written', async () => {
  const { env, calls } = ghOnPath('[]', 4)
  const r = await run(['x'], { ...env, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 1, stdout: [], stderr: ['mutation-issue: gh issue list exited 4'] })
  assert.equal(calls().length, 1)
})

test('run: an environment whose PATH has no gh exits 1 instead of passing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-no-gh-'))
  onTestFinished(() => fs.rmSync(empty, { recursive: true, force: true }))
  const r = await run(['x'], { PATH: empty, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 1, stdout: [], stderr: ['mutation-issue: gh issue list exited null'] })
})

test('run: the report path on the command line is read, and its score reaches the issue gh creates', async () => {
  const { env, calls } = ghOnPath('[]')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-mutation-report-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const report = path.join(dir, 'mutation.json')
  const mutants = ['Killed', 'Killed', 'Timeout', 'Survived'].map((status, i) => ({ id: String(i), status }))
  fs.writeFileSync(report, JSON.stringify({ files: { 'lib/a.mjs': { mutants } } }))
  const r = await run([report], { ...env, RUN_URL: RUN })
  assert.equal(r.exitCode, 0)
  const create = calls()[1] ?? []
  assert.deepEqual(create.slice(0, 2), ['issue', 'create'])
  assert.match(create[3] ?? '', /\b75\.00%/)
  assert.match(create[5] ?? '', /\b75\.00%/)
})

/** @param {string} stryker @returns {string} a `gh run view --json jobs` listing whose Stryker step ended so */
const jobs = stryker => JSON.stringify({ jobs: [{ name: 'mutation', steps: [{ name: 'Stryker over lib/', conclusion: stryker }] }] })

test('run --lost-runner: a Stryker step that ended cancelled is filed as cut off, with no report', async () => {
  const { env, calls } = ghOnPath('[]', 0, jobs('cancelled'))
  const r = await run(['--lost-runner', '40423145899'], { ...env, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 0, stdout: ['created: Weekly mutation run failed (cut off, no report)'], stderr: [] })
  assert.deepEqual(calls()[0], ['run', 'view', '40423145899', '--json', 'jobs'])
  assert.match(calls()[2]?.[5] ?? '', /lost runner/)
})

test('run --lost-runner: with an open issue the cut-off run is a comment there', async () => {
  const { env, calls } = ghOnPath('[{"number":7,"title":"Weekly mutation run failed (65.10%)"}]', 0, jobs('cancelled'))
  const r = await run(['--lost-runner', '1'], { ...env, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 0, stdout: ['commented on #7'], stderr: [] })
  assert.deepEqual(calls()[2], ['issue', 'comment', '7', '--body', `Failed again: ${RUN}\n\nScore: cut off, no report.`])
})

test('run --lost-runner: a Stryker step that failed or was never listed files nothing — the first job reports a failure', async () => {
  for (const [listing, ended] of [[jobs('failure'), 'failure'], [jobs('success'), 'success'], ['{}', 'unlisted']]) {
    const { env, calls } = ghOnPath('[]', 0, listing)
    const r = await run(['--lost-runner', '1'], { ...env, RUN_URL: RUN })
    assert.deepEqual(r, { exitCode: 0, stdout: [`Stryker step ended ${ended}: no lost runner, nothing filed`], stderr: [] })
    assert.equal(calls().length, 1)
  }
})

test('run --lost-runner: a gh that cannot list the jobs exits 1 instead of passing', async () => {
  const { env } = ghOnPath('[]', 4)
  const r = await run(['--lost-runner', '1'], { ...env, RUN_URL: RUN })
  assert.deepEqual(r, { exitCode: 1, stdout: [], stderr: ['mutation-issue: gh run view exited 4'] })
})
