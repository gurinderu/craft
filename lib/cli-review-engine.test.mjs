// The cli-review engine (src/cli-review.js, lib/cli-review-steps.mjs) driven end to end with scripted agents: the
// service agent's command output stands in for the `craft` binary, and each scripted task agent writes its answer
// file in a temporary run directory as a real one would; the scripted submit reads those files back, as the binary
// does. What is pinned is the driver's loop — start, the step's tasks told where their files are, submit, done, the
// report — and that no prompt, schema or answer passes through a model's copy.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CALL_SPEND, runEngine } from './engine-harness.mjs'

let RUN = ''
beforeEach(() => { RUN = mkdtempSync(join(tmpdir(), 'craft-run-')) })
afterEach(() => { rmSync(RUN, { recursive: true, force: true }) })

/** The task as the binary prints it: its files in the run directory. @param {string} id @param {string} label @param {string} model */
const task = (id, label, model) => ({
  id, label, model,
  promptFile: `${RUN}/tasks/${id}.md`, schemaFile: `${RUN}/tasks/${id}.schema.json`, answerFile: `${RUN}/answers/${id}.json`,
})
const lens = () => task('lens-intent', 'lens:intent', 'opus')
const verify = () => task('verify-0', 'verify:src/a.rs:3', 'sonnet')
const FINDINGS = { lens: 'intent', findings: [{ severity: 'High', title: 't', file: 'src/a.rs', line: 3 }] }
const VERDICT = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'seen' }

/** A service agent's answer carrying `value` as the command's stdout. @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
const done = () => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
const REPORT = ran('# craft review: Block\n\n## Confirmed findings\n')

/** A scripted task agent: writes `answer` to the answer file its prompt names, then says done. @param {unknown} answer */
const writes = answer => (/** @type {{ prompt: string }} */ { prompt }) => {
  const file = /to (\/\S+\.json) \(create/.exec(prompt)?.[1]
  assert.ok(file, prompt)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(answer))
  return 'done'
}
/** The answer file of task `id` as the binary would read it. @param {string} id @returns {unknown} */
const answerOf = id => JSON.parse(readFileSync(`${RUN}/answers/${id}.json`, 'utf8'))

test('one full loop: start, the lens, its findings verified, done, the report — all through files', async () => {
  /** @type {unknown[]} */
  const seen = []
  const run = await runEngine('cli-review', {
    args: { repo: '/work/repo', base: 'origin/main', craftBin: '/opt/craft' },
    script: {
      'step:start': pending([lens()]),
      lens: writes(FINDINGS),
      'step:submit:1': () => { seen.push(answerOf('lens-intent')); return pending([verify()]) },
      verify: writes(VERDICT),
      'step:submit:2': () => { seen.push(answerOf('verify-0')); return done() },
      'step:report': REPORT,
    },
  })
  assert.deepEqual(run.calls.map(c => c.label), ['step:start', 'lens:intent', 'step:submit:1', 'verify:src/a.rs:3', 'step:submit:2', 'step:report'])
  assert.deepEqual(seen, [FINDINGS, VERDICT], 'each answer reached the binary as the file its agent wrote')
  const [start, lensCall, submit1, , , report] = run.calls.map(c => ({ prompt: c.prompt, opts: c.opts }))
  assert.ok(start && lensCall && submit1 && report)
  assert.match(start.prompt, /^Run exactly this one command:\n\n'\/opt\/craft' review start --cwd '\/work\/repo' --base 'origin\/main'$/m)
  assert.equal(start.opts.agentType, 'craft:engine-service')
  assert.equal(lensCall.prompt, `Read the file ${RUN}/tasks/lens-intent.md and do exactly what it says. When done, write your final answer as JSON matching the schema in ${RUN}/tasks/lens-intent.schema.json to ${RUN}/answers/lens-intent.json (create the directory if needed), then reply with the single word done.`)
  assert.deepEqual([lensCall.opts.model, lensCall.opts.schema, lensCall.opts.agentType], ['opus', undefined, undefined], 'the model the binary named, no schema, the default type')
  assert.equal(submit1.prompt.split('\n\n')[1], `'/opt/craft' review submit --run '${RUN}'`)
  assert.doesNotMatch(submit1.prompt, /findings|--answers/, 'no answer passes through the service agent')
  assert.match(report.prompt, /cat '.*\/report\.md'/)
  assert.equal(run.report, `Verdict: Block (run ${RUN})\n\n# craft review: Block\n\n## Confirmed findings\n`)
  assert.deepEqual(run.phases, ['Start', 'Agents', 'Submit', 'Agents', 'Submit', 'Report'])
  assert.ok(run.logs.some(l => l === 'round 1: 1 task(s) — lens:intent'), run.logs.join('\n'))
})

test('a dead agent writes no file; the retry the binary hands back runs again on the task\'s own agent type', async () => {
  const typed = { ...lens(), agentType: 'craft:rust-reviewer' }
  /** @type {boolean[]} */
  const fileAtSubmit = []
  const run = await runEngine('cli-review', {
    args: {},
    script: {
      'step:start': pending([typed]),
      lens: (/** @type {{ callIndex: number, prompt: string }} */ c) => (c.callIndex === 0 ? null : writes(FINDINGS)(c)),
      'step:submit:1': () => { fileAtSubmit.push(existsSync(typed.answerFile)); return pending([typed]) },
      'step:submit:2': () => { fileAtSubmit.push(existsSync(typed.answerFile)); return done() },
      'step:report': REPORT,
    },
  })
  assert.deepEqual(fileAtSubmit, [false, true])
  const lensCalls = run.calls.filter(c => c.label === 'lens:intent')
  assert.deepEqual(lensCalls.map(c => c.opts.agentType), ['craft:rust-reviewer', 'craft:rust-reviewer'])
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
  const relative = await runEngine('cli-review', { args: {}, script: { 'step:start': pending([{ ...lens(), answerFile: 'answers/x.json' }]) } })
  assert.match(relative.report, /^INCOMPLETE — .*no well-formed tasks/, 'a task file that is not an absolute path is refused')
  const refused = await runEngine('cli-review', { args: { craftBin: 'craft' }, script: {} })
  assert.match(refused.report, /^INCOMPLETE — cli-review: craftBin="craft" is not an absolute path\. Nothing ran\./)
  assert.equal(refused.calls.length, 0)
})

test('a spent budget fails the run closed rather than reporting a verdict', async () => {
  const script = { 'step:start': pending([lens()]), lens: writes(FINDINGS), 'step:submit:1': done(), 'step:report': REPORT }
  await assert.rejects(runEngine('cli-review', { args: {}, script, budgetTotal: CALL_SPEND * 2 }), /budget exhausted/)
})
