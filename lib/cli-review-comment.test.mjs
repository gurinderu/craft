// The cli-review driver publishing a finished run's findings after the fact (`run=` with `comment=true`,
// lib/cli-review-steps.mjs; realm @nick/craft, node #270): it runs the binary's `craft review comment` through the
// service agent and answers with the run's verdict and what landed on the PR, files nothing itself — not even when the
// binary refuses, which is said in its own words — and still refuses comment=false or any other start option beside
// run=.
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

const PUBLISHED = () => ({
  run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block', line: 'Block — 1 High',
  findings: [{ severity: 'High', file: 'src/lib.rs', line: 1, title: 'f returns the wrong value', tier: 'confirmed' }],
  sorting: { defect: 1, doubtful: 1, inDiffJudged: true, findings: [] },
  prComments: { pr: 7, url: 'u', requested: 1, posted: 1, already: 0, failed: 0, noFile: 0, reason: 'PR #7 https://github.com/o/r/pull/7', error: '' },
  filing: { runDir: '', rejoin: false, lost: [], record: 'filed', refiledFile: '/store/r.json' },
})

test('run= with comment=true publishes the finished run through the binary and files nothing itself', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin', run: RUN, comment: true },
    script: {
      'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' },
      'step:comment': ran(PUBLISHED()),
    },
  })
  const comment = run.calls.find(c => c.label === 'step:comment')
  assert.match(comment?.prompt ?? '', new RegExp(`^'/opt/craft' review comment --run '${RUN}' --record-root '/plugin'$`, 'm'))
  assert.match(run.report, /^## Verdict\n\n⛔ Block — 1 High/)
  assert.match(run.report, /PR comments: 1 of 1 defect\(s\) posted, 0 already on the PR — PR #7 https:\/\/github\.com\/o\/r\/pull\/7\./)
  assert.match(run.report, /Doubtful: 1 finding\(s\) held back from the PR/)
  assert.match(run.report, /- \[High\] src\/lib\.rs:1 — f returns the wrong value \(confirmed\)/)
  assert.deepEqual(run.calls.map(c => c.label), ['step:root', 'step:comment'], 'no submit, no lens, no logger')
})

test('a refusal is said in the binary\'s words, nothing posted and nothing filed', async () => {
  const why = 'nothing was posted: the PR\'s head moved to bbbbbbbbbbbb since the reviewed head aaaaaaaaaaaa, and its new commits change the lines of 1 defect(s): `src/lib.rs:1` f returns the wrong value — review the PR\'s head again'
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, comment: true },
    script: {
      'step:locate': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' },
      'step:comment': { exitCode: 1, stdout: '', stderr: `craft: ${why}\n` },
    },
  })
  assert.ok(run.report.startsWith(`## Verdict\n\n⚠️ Nothing was posted on the PR — run=${JSON.stringify(RUN)} cannot be published on its PR: ${why}`), run.report)
  assert.deepEqual(run.calls.map(c => c.label), ['step:locate', 'step:comment'], 'no INCOMPLETE record of a run the binary finished')
})

test('a write of the record that did not land is said with the answer', async () => {
  const step = { ...PUBLISHED(), filing: { runDir: '', rejoin: false, lost: ['the publication in the run record — record not readable'], record: 'filed' } }
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin', run: RUN, comment: true },
    script: { 'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' }, 'step:comment': ran(step) },
  })
  assert.match(run.report, /the publication in the run record — record not readable/)
})

test('comment=false and any other start option beside run= are still refused', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, comment: false },
    script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } },
  })
  assert.match(run.report, /cli-review cannot honour `comment` beside run=/)
  const both = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, comment: true, depth: 'light' },
    script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } },
  })
  assert.match(both.report, /cli-review cannot honour `depth` beside run=/)
  assert.ok(!both.calls.some(c => c.label === 'step:comment'))
})

test('a lost step or a dead service agent is no refusal: the outcome is said unknown, with how to check it', async () => {
  for (const got of [null, { exitCode: 124, stdout: '', stderr: 'timed out' }, { exitCode: 0, stdout: 'garbled', stderr: '' }]) {
    const run = await runEngine('cli-review', {
      args: { craftBin: '/opt/craft', craftRoot: '/plugin', run: RUN, comment: true },
      script: { 'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' }, 'step:comment': got },
    })
    assert.doesNotMatch(run.report, /Nothing was posted/, JSON.stringify(got))
    assert.match(run.report, /whether anything was posted on the PR is unknown/)
    assert.ok(run.report.includes(`craft review status --run '${RUN}'`), run.report)
    assert.match(run.report, /craft-finding/)
    assert.ok(!run.calls.some(c => /log-run|submit|lens/.test(c.label)), 'nothing filed, no review run')
  }
})

test('pr= names the pull request of a run reviewed on a detached HEAD, and goes only with run= and comment=true', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin', run: RUN, comment: true, pr: 42 },
    script: { 'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' }, 'step:comment': ran(PUBLISHED()) },
  })
  assert.match(run.calls.find(c => c.label === 'step:comment')?.prompt ?? '', new RegExp(`^'/opt/craft' review comment --run '${RUN}' --pr 42 --record-root '/plugin'$`, 'm'))
  for (const args of [{ craftBin: '/opt/craft', pr: 42 }, { craftBin: '/opt/craft', run: RUN, pr: 42 }, { craftBin: '/opt/craft', run: RUN, comment: true, pr: '42; rm' }]) {
    const refused = await runEngine('cli-review', { args, script: { 'log-run': { ok: true, output: ['wrote /store/r.json'] } } })
    assert.match(refused.report, /pr=/, JSON.stringify(args))
    assert.ok(!refused.calls.some(c => c.label === 'step:comment' || c.label === 'step:start'), JSON.stringify(args))
  }
})

test('a stopped run given comment=true is told to resume first, then publish', async () => {
  const stopped = `the run in ${RUN} has not finished: resume it first (\`craft review submit --run <dir> --resume\`)`
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin', run: RUN, comment: true },
    script: { 'step:root': { exitCode: 0, stdout: 'root=/plugin\n', stderr: '' }, 'step:comment': { exitCode: 1, stdout: '', stderr: `craft: ${stopped}\n` } },
  })
  assert.ok(run.report.includes(`resume it with the Workflow \`craft:cli-review run=${RUN}\` alone, then publish its findings with \`run=${RUN} comment=true\``), run.report)
})
