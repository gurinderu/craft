// The triage engine (integrations/claude-code/src/triage-findings.js, integrations/shared/cli-triage-steps.mjs) driven end to
// end with scripted agents: the service agent's command output stands in for the `craft` binary, each scripted task
// agent writes its answer file as a real one would. What is pinned is the driver's loop — the binary got, the start
// with the engine's arguments, the step's tasks told where their files are, submit, done — and its answer: where the
// plan is, never the plan copied; a stop and how to resume; a lost step read back from the binary's status; a run the
// binary never finished filed INCOMPLETE, and one it finished or stopped not filed by the driver (realm @nick/craft,
// node #616).
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { filedRecord, runEngine } from './engine-harness.mjs'

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-triage-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

/** A task as the binary prints it. @param {string} id @param {string} label @param {string} model @param {string} kind */
const task = (id, label, model, kind) => ({
  id,
  label,
  model,
  kind,
  promptFile: `${RUN}/tasks/${id}.md`,
  schemaFile: `${RUN}/tasks/${id}.schema.json`,
  answerFile: `${RUN}/answers/${id}.json`,
})
/** A service agent's answer carrying `value` as stdout. @param {unknown} value @param {number} [exitCode] @param {string} [stderr] */
const ran = (value, exitCode = 0, stderr = '') => ({ exitCode, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr })
const RESOLVED = ran('root=/p/craft\nbin=/b/craft\n')
const pending = (/** @type {object[]} */ tasks) => ran({ run: RUN, done: false, phase: 'gather', tasks })
const PLAN_FILE = () => `${RUN}/plan.json`
const done = (/** @type {Record<string, unknown>} */ more = {}) =>
  ran({
    run: RUN,
    done: true,
    planFile: PLAN_FILE(),
    recordFile: `${RUN}/record.json`,
    summary: 'Two accepted, one deferred.',
    filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
    ...more,
  })
/** A task agent that writes `answer` to the answer file its prompt names. @param {unknown} answer */
const writes =
  answer =>
  (/** @type {{ prompt: string }} */ { prompt }) => {
    const file = /to (\/\S+\.json) \(create/.exec(prompt)?.[1]
    assert.ok(file, prompt)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(answer))
    return 'done'
  }
/** The command a service step was asked to run. @param {{ calls: { label: string, prompt: string }[] }} run @param {string} label */
const command = (run, label) => {
  const c = run.calls.find(x => x.label === label)
  assert.ok(c, `no ${label}: ${run.calls.map(x => x.label).join(', ')}`)
  return /\n\n(.+)\n\nReturn \{exitCode/s.exec(c.prompt)?.[1] ?? ''
}
const logged = (/** @type {{ calls: { label: string }[] }} */ run) => run.calls.filter(c => /^log-run/.test(c.label))

const GATHER = () => task('gather-report', 'gather:report', 'sonnet', 'gatherReport')
const PLAN = () => task('plan', 'plan', 'opus', 'plan')

test('a run gets the binary, starts with the engine’s arguments, runs each step’s tasks and names the plan file', async () => {
  const run = await runEngine('triage-findings', {
    args: { report: '/r/report.md', base: 'abc123', prBase: 'def456', repo: '/work/repo', priorLedger: [{ stable_id: 'x', verdict: 'reject', reason: 'r' }] },
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([GATHER()]),
      'gather:report': writes({ source: 'review', findings: [] }),
      'step:submit:1': pending([PLAN()]),
      plan: writes({ plan_markdown: 'BODY', summary: 'S', ledger: [] }),
      'step:submit:2': done(),
    },
  })
  const start = command(run, 'step:start')
  for (const part of [
    "/b/craft triage start --repo '/work/repo' --report '/r/report.md' --base 'abc123' --pr-base 'def456'",
    '--prior-ledger <(printf \'%s\' \'[{"stable_id":"x"',
    ' --record ',
    " --record-root '/p/craft'",
  ])
    assert.ok(start.includes(part), `${part} in ${start}`)
  assert.match(command(run, 'step:submit:2'), /^\/b\/craft triage submit --run '.+' --agents 2/)
  assert.equal(run.calls.find(c => c.label === 'plan')?.opts.model, 'opus', 'the task runs on the model the binary named')
  assert.match(run.report, new RegExp(`^## Triage\\n\\nThe plan is ${PLAN_FILE()} — read that file for the plan`))
  assert.ok(run.report.includes('Two accepted, one deferred.'), run.report)
  assert.ok(!run.report.includes('BODY'), 'the plan is read from its file, never copied into the answer')
  assert.deepEqual(logged(run), [], 'the binary files a finished run’s record itself')
})

test('run= resumes the run with the binary’s submit --resume, never a start', async () => {
  const run = await runEngine('triage-findings', { args: { run: '/r/run-1', repo: '/work/repo' }, script: { 'step:resolve': RESOLVED, 'step:resume': done() } })
  assert.match(command(run, 'step:resume'), /^\/b\/craft triage submit --run '\/r\/run-1' --resume --agents 0/)
  assert.ok(!run.calls.some(c => c.label === 'step:start'))
  assert.match(run.report, /^## Triage\n\nThe plan is /)
})

test('a run the binary stopped on the usage limit says how to resume it and is filed by no one here', async () => {
  const stopped = ran({
    run: RUN,
    done: true,
    phase: 'validate',
    stopped: { cause: 'limit', text: 'weekly limit' },
    line: 'stopped: usage limit reached (weekly limit)',
    resume: 'r',
  })
  const run = await runEngine('triage-findings', { args: { report: '/r.md' }, script: { 'step:resolve': RESOLVED, 'step:start': stopped } })
  assert.match(run.report, /^## Triage\n\n⚠️ INCOMPLETE — stopped: usage limit reached \(weekly limit\)\. The run is in /)
  assert.ok(run.report.includes(`craft:triage-findings run=${RUN}`), run.report)
  assert.deepEqual(logged(run), [])
})

test('a plan that failed is said in the binary’s words', async () => {
  const run = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: { 'step:resolve': RESOLVED, 'step:start': done({ summary: undefined, failed: 'Triage failed: the Plan-phase agent returned no result.' }) },
  })
  assert.match(run.report, /^## Triage\n\nTriage failed: the Plan-phase agent returned no result\.\n\nThe plan file .+plan\.json holds the same/)
})

test('a lost submit is read back from the status: a run the binary ended ends as it says', async () => {
  const status = ran({ run: RUN, phase: 'done', done: true, tasks: [], planFile: PLAN_FILE(), recordFile: `${RUN}/record.json`, summary: 'S' })
  const run = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: { 'step:resolve': RESOLVED, 'step:start': pending([PLAN()]), plan: writes({}), 'step:submit:1': null, 'step:status': status },
  })
  assert.match(run.report, /^## Triage\n\nThe plan is /)
  assert.deepEqual(logged(run), [])
})

test('a lost submit of a run still going stops it INCOMPLETE, filed with the stop’s lines', async () => {
  const status = ran({ run: RUN, phase: 'validate', done: false, tasks: [] })
  const run = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([PLAN()]),
      plan: writes({}),
      'step:submit:1': null,
      'step:status': status,
      'log-run': { ok: true },
    },
  })
  assert.match(run.report, /^## Triage\n\n⚠️ INCOMPLETE — triage stopped \(the binary reports the validate phase\): /)
  const record = filedRecord(run)
  assert.equal(record?.verdict, 'INCOMPLETE')
  assert.deepEqual(record?.notRun, ['the craft binary did not finish the run', 'stopped: a step of the binary was lost'])
})

test('an argument the engine does not take is refused before any agent but the logger', async () => {
  const run = await runEngine('triage-findings', { args: { report: '/r.md', depth: 'light' }, script: { 'log-run': { ok: true } } })
  assert.deepEqual(
    run.calls.map(c => c.label.replace(/:.*$/, '')),
    ['log-run'],
  )
  assert.match(run.report, /^## Verdict\n⚠️ INCOMPLETE — triage-findings cannot honour `depth`/)
  assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE (argument refused)')
})

test('an argument the binary refuses at the start is filed as a refusal, in the binary’s words', async () => {
  const run = await runEngine('triage-findings', {
    args: { base: 'x' },
    script: { 'step:resolve': RESOLVED, 'step:start': ran('', 2, 'craft: triage needs a source: --report or --pr'), 'log-run': { ok: true } },
  })
  assert.match(run.report, /INCOMPLETE — triage: triage needs a source: --report or --pr\. Nothing ran\./)
  assert.deepEqual(filedRecord(run)?.notRun, ['an argument value triage cannot use was refused, nothing ran'])
})

test('a write the binary could not land is said in the answer', async () => {
  const run = await runEngine('triage-findings', {
    args: { report: '/r.md' },
    script: {
      'step:resolve': RESOLVED,
      'step:start': done({ filing: { runDir: '', rejoin: false, lost: ['the run record — the index lock stayed taken'], record: 'failed' } }),
    },
  })
  assert.match(run.report, /Telemetry lost[\s\S]*the run record — the index lock stayed taken/)
})
