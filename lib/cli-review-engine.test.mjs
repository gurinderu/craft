// The cli-review engine (src/cli-review.js, lib/cli-review-steps.mjs) driven end to end with scripted agents: the
// service agent's command output stands in for the `craft` binary, so what is pinned is the driver's loop — start,
// the step's tasks run with what the binary gave them, their answers handed back, done, the report.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { CALL_SPEND, runEngine } from './engine-harness.mjs'

const RUN = '/tmp/craft-run'
const SCHEMA = { type: 'object', required: ['lens', 'findings'] }
const LENS = { id: 'lens:intent', label: 'lens:intent', prompt: 'LENS PROMPT', model: 'opus', schema: SCHEMA }
const VERIFY = { id: 'verify:0', label: 'verify:src/a.rs:3', prompt: 'VERIFY PROMPT', model: 'sonnet', schema: { type: 'object' } }
const FINDINGS = { lens: 'intent', findings: [{ severity: 'High', title: 't', file: 'src/a.rs', line: 3 }] }
const VERDICT = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'seen' }

/** A service agent's answer carrying `value` as the command's stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
const DONE = ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
const REPORT = ran('# craft review: Block\n\n## Confirmed findings\n')

/** The JSON a submit prompt hands the service agent to write. @param {string} prompt */
const answersIn = prompt => JSON.parse(prompt.split('----- BEGIN ANSWERS -----\n')[1]?.split('\n----- END ANSWERS -----')[0] ?? 'null')

test('one full loop: start, the lens, its findings verified, done, the report', async () => {
  const run = await runEngine('cli-review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft' },
    script: {
      'step:start': pending([LENS]),
      lens: FINDINGS,
      'step:submit:1': pending([VERIFY]),
      verify: VERDICT,
      'step:submit:2': DONE,
      'step:report': REPORT,
    },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:start', 'lens:intent', 'step:submit:1', 'verify:src/a.rs:3', 'step:submit:2', 'step:report'])
  const [start, lens, submit1, , submit2, report] = run.calls.map(c => ({ prompt: c.prompt, opts: c.opts }))
  assert.ok(start && lens && submit1 && submit2 && report)
  assert.match(start.prompt, /^Run exactly this one command:\n\n'\/opt\/craft' review start --cwd '\/work\/repo' --base 'origin\/main'$/m)
  assert.equal(start.opts.agentType, 'craft:engine-service')
  assert.deepEqual([lens.prompt, lens.opts.model, lens.opts.schema], ['LENS PROMPT', 'opus', SCHEMA], 'the task runs as the binary gave it')
  assert.match(submit1.prompt, /'\/opt\/craft' review submit --run '\/tmp\/craft-run' --answers '\/tmp\/craft-run\/answers-1\.json'/)
  assert.deepEqual(answersIn(submit1.prompt), { 'lens:intent': FINDINGS })
  assert.deepEqual(answersIn(submit2.prompt), { 'verify:0': VERDICT })
  assert.match(report.prompt, /cat '\/tmp\/craft-run\/report\.md'/)
  assert.equal(run.report, `Verdict: Block (run ${RUN})\n\n# craft review: Block\n\n## Confirmed findings\n`)
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit', 'Report'])
  assert.ok(run.logs.some(l => l === 'round 1: 1 task(s) — lens:intent'), run.logs.join('\n'))
})

test('a dead agent is left out of the answers, and the retry the binary hands back runs again', async () => {
  const retry = { ...LENS, prompt: 'LENS PROMPT\n\nYour previous answer was invalid: no answer was submitted.' }
  const run = await runEngine('cli-review', {
    args: {},
    script: {
      'step:start': pending([LENS]),
      lens: (/** @type {{ callIndex: number }} */ { callIndex }) => (callIndex === 0 ? null : FINDINGS),
      'step:submit:1': pending([retry]),
      'step:submit:2': DONE,
      'step:report': REPORT,
    },
  })
  const submits = run.calls.filter(c => c.label.startsWith('step:submit'))
  assert.deepEqual(answersIn(submits[0]?.prompt ?? ''), {}, 'a dead lens is no answer: the binary decides what that means')
  assert.deepEqual(answersIn(submits[1]?.prompt ?? ''), { 'lens:intent': FINDINGS })
  assert.equal(run.calls.filter(c => c.label === 'lens:intent')[1]?.prompt, retry.prompt)
  assert.match(run.calls[0]?.prompt ?? '', /"\$\{CLAUDE_PLUGIN_ROOT\}\/cli\/target\/release\/craft" review start --cwd \.$/m)
  assert.match(run.report, /^Verdict: Block/)
})

test('a step that cannot be read ends the run INCOMPLETE, never as a verdict', async () => {
  const failed = await runEngine('cli-review', {
    args: {},
    script: { 'step:start': { exitCode: 1, stdout: '', stderr: 'craft: the base nope is not a commit' } },
  })
  assert.match(failed.report, /^INCOMPLETE — cli-review stopped at round 1: the command exited 1: craft: the base nope is not a commit/)
  const garbled = await runEngine('cli-review', { args: {}, script: { 'step:start': ran('{"run": "/tmp/x", "tasks": [') } })
  assert.match(garbled.report, /^INCOMPLETE — .*printed no JSON/)
  const refused = await runEngine('cli-review', { args: { craftBin: 'craft' }, script: {} })
  assert.match(refused.report, /^INCOMPLETE — cli-review: craftBin="craft" is not an absolute path\. Nothing ran\./)
  assert.equal(refused.calls.length, 0)
})

test('a spent budget fails the run closed rather than reporting a verdict', async () => {
  const script = { 'step:start': pending([LENS]), lens: FINDINGS, 'step:submit:1': DONE, 'step:report': REPORT }
  await assert.rejects(runEngine('cli-review', { args: {}, script, budgetTotal: CALL_SPEND * 2 }), /budget exhausted/)
})
