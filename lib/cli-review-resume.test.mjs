// The cli-review driver's resume (`run=`, lib/cli-review-steps.mjs): the binary's refusal of a checkout that moved
// since the run started is reported plainly with no resume offered, start options beside run= are refused rather
// than ignored, and a run that gives up on its round backstop says how to resume it.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEngine } from './engine-harness.mjs'

let RUN = ''
beforeEach(() => { RUN = mkdtempSync(join(tmpdir(), 'craft-run-')) })
afterEach(() => { rmSync(RUN, { recursive: true, force: true }) })

/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
const lens = () => ({
  id: 'lens-errors-r1', label: 'lens:errors', model: 'opus',
  promptFile: `${RUN}/tasks/l.md`, schemaFile: `${RUN}/tasks/l.schema.json`, answerFile: `${RUN}/answers/l.json`,
})

test('a resume over a moved HEAD is refused in the binary\'s words, with no resume offered', async () => {
  const moved = 'HEAD moved since this run stopped (aaaaaaaaaaaa → bbbbbbbbbbbb); start a new review'
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN },
    script: { 'step:resume': { exitCode: 1, stdout: '', stderr: `craft: ${moved}\n` } },
  })
  assert.ok(run.report.includes(`cli-review stopped at round 1: run=${JSON.stringify(RUN)} cannot be resumed: ${moved}.`), run.report)
  assert.doesNotMatch(run.report, /To resume it|The run is in/)
  assert.equal(run.calls.filter(c => c.label.startsWith('lens')).length, 0, 'the run is not continued')
})

test('start options beside run= are refused before anything runs, naming each', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, comment: true, path: 'crates/a', strict: false },
    script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } },
  })
  assert.match(run.report, /cli-review cannot honour `strict`, `path`, `comment` beside run=: a resumed run goes on with the options it was started with/)
  assert.deepEqual(run.calls.map(c => c.label), ['log-run'], 'only the refusal is filed')
  const plain = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, repo: '/work/repo' },
    script: { 'step:resume': ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Approve', line: 'Approve' }) },
  })
  assert.match(plain.report, /^## Verdict\n\n✅ Approve/, 'repo= and craftBin= still go with run=')
})

test('a run that gives up on its round backstop names its run and how to resume it', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', repo: '/work/repo' },
    script: { step: ran({ run: RUN, tasks: [lens()], done: false }), lens: 'done' },
  })
  assert.ok(run.report.includes(`cli-review gave up after 51 rounds; the run is in ${RUN}. To resume it`), run.report)
  assert.ok(run.report.includes(`craft:cli-review run=${RUN}`), run.report)
})
