// The audit engine (integrations/claude-code/src/audit.js, integrations/shared/cli-audit-steps.mjs) driven end to end with
// scripted agents: the service agent's command output stands in for the `craft` binary, each scripted task agent
// writes its answer file as a real one would. What is pinned is the driver's loop — the binary got, the start with the
// engine's arguments, the lens and verifier tasks told where their files are, submit, done — and its answer: the
// verdict, where the report is, never the report copied, and the counts of what the pass left; a pass that left files
// unread or findings unjudged never read as clean; a stop and how to resume; a lost step read back from the binary's
// status; a run the binary never finished filed INCOMPLETE, and one it finished or stopped not filed by the driver
// (realm @nick/craft, node #588).
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { filedRecord, runEngine } from './engine-harness.mjs'

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-audit-'))
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
const pending = (/** @type {object[]} */ tasks, phase = 'lens') => ran({ run: RUN, done: false, phase, pass: 1, repo: '/work/repo', tasks })
const REPORT = () => `${RUN}/report.md`
/** The binary's finished step. @param {Record<string, unknown>} more */
const finishedStep = (more = {}) => ({
  run: RUN,
  done: true,
  phase: 'done',
  pass: 1,
  verdict: 'Warning',
  report: REPORT(),
  recordFile: `${RUN}/record.json`,
  filing: { runDir: '', rejoin: false, lost: [], record: 'filed' },
  ...more,
})
const done = (/** @type {Record<string, unknown>} */ more = {}) => ran(finishedStep(more))
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
const labels = (/** @type {{ calls: { label: string }[] }} */ run) => run.calls.map(c => c.label.replace(/:.*$/, ''))

const LENS_LABEL = 'rust errors · batch 1 (2 file(s))'
const LENS = () => task('lens-1-rust-errors-0', LENS_LABEL, 'sonnet', 'lens')
const VERIFY = () => task('verify-1-0', 'verify 1 rust finding(s)', 'opus', 'verify')

test('a run gets the binary, starts with the engine’s arguments, runs the lens then verifier tasks and names the report', async () => {
  const run = await runEngine('audit', {
    args: { path: ['src', 'lib dir'], batchBytes: 5000, lensAgents: '3', repo: '/work/repo' },
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([LENS()]),
      [LENS_LABEL]: writes({ findings: [] }),
      'step:submit:1': pending([VERIFY()], 'verify'),
      'verify 1 rust finding(s)': writes({ verdicts: [] }),
      'step:submit:2': done({ unverifiedLow: { count: 2, file: `${RUN}/unverified.md` } }),
    },
  })
  assert.equal(
    command(run, 'step:start'),
    "/b/craft audit start --cwd '/work/repo' --path='src' --path='lib dir' --batch-bytes '5000' --lens-agents '3' --record '0.61.0' --record-root '/p/craft'",
  )
  assert.equal(command(run, 'step:submit:2'), `/b/craft audit submit --run '${RUN}'`)
  assert.equal(run.calls.find(c => c.label === LENS_LABEL)?.opts.model, 'sonnet', 'the lens task runs on the model the binary named')
  assert.equal(run.calls.find(c => c.label.startsWith('verify'))?.opts.model, 'opus', 'the verifier runs on the model the binary named')
  assert.match(run.report, new RegExp(`^## Audit\\n\\nVerdict: Warning\\n\\nThe report is ${REPORT()} — read that file for the findings`))
  assert.ok(run.report.includes('Counts: unread=0 file(s), unjudged=0 finding(s), unverifiedLow=2 finding(s).'), run.report)
  assert.ok(run.report.includes(`The unverified Low and Info findings are listed in ${RUN}/unverified.md.`), run.report)
  assert.ok(run.report.includes('craft:addressing-findings'), run.report)
  assert.doesNotMatch(run.report, /INCOMPLETE|run=/, 'a clean pass offers no resume')
  assert.deepEqual(logged(run), [], 'the binary files a finished pass’s record itself')
})

test('nothing given starts over the session’s checkout with only the record', async () => {
  const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': done({ verdict: 'Approve' }) } })
  assert.equal(command(run, 'step:start'), "/b/craft audit start --record '0.61.0' --record-root '/p/craft'")
  assert.match(run.report, /^## Audit\n\nVerdict: Approve\n\n/)
})

test('a pass the binary ended INCOMPLETE says so first, names the unread file and how to go on, and is filed by no one here', async () => {
  const run = await runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': done({
        verdict: 'Block (INCOMPLETE)',
        unread: { count: 3, file: `${RUN}/unread.txt` },
        unjudged: 1,
        resume: `craft audit submit --run '${RUN}' --resume`,
      }),
    },
  })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — verdict Block \(INCOMPLETE\): /)
  assert.ok(run.report.includes('Counts: unread=3 file(s), unjudged=1 finding(s), unverifiedLow=0 finding(s).'), run.report)
  assert.ok(run.report.includes(`The unread files are listed in ${RUN}/unread.txt.`), run.report)
  assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
  assert.deepEqual(logged(run), [])
})

for (const [name, more] of Object.entries({
  'an unread file': { verdict: 'Approve', unread: { count: 1, file: '/r/unread.txt' } },
  'an unjudged finding': { verdict: 'Approve', unjudged: 2 },
  'a verdict of INCOMPLETE alone': { verdict: 'INCOMPLETE' },
}))
  test(`a pass with ${name} never reads as clean`, async () => {
    const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': done(more) } })
    assert.ok(run.report.startsWith(`## Audit\n\n⚠️ INCOMPLETE — verdict ${more.verdict}: `), run.report)
    assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
  })

test('a record the binary could not land is said, with how to file it again', async () => {
  const run = await runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': done({
        verdict: 'Approve',
        resume: 'r',
        filing: { runDir: '', rejoin: false, lost: ['the run record — the index lock stayed taken'], record: 'failed' },
      }),
    },
  })
  assert.match(run.report, /^## Audit\n\nVerdict: Approve\n\n/)
  assert.match(run.report, /Telemetry lost[\s\S]*the run record — the index lock stayed taken/)
  assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
})

test('run= resumes the run with the binary’s submit --resume, never a start', async () => {
  const run = await runEngine('audit', { args: { run: '/r/run-1', repo: '/work/repo' }, script: { 'step:resolve': RESOLVED, 'step:resume': done() } })
  assert.equal(command(run, 'step:resume'), "/b/craft audit submit --run '/r/run-1' --resume")
  assert.ok(!run.calls.some(c => c.label === 'step:start'))
  assert.match(run.report, /^## Audit\n\nVerdict: Warning/)
})

test('a run the binary stopped on the usage limit says how to resume it and is filed by no one here', async () => {
  const stopped = ran({
    run: RUN,
    done: true,
    phase: 'verify',
    stopped: { cause: 'limit', text: 'weekly limit' },
    line: 'stopped: usage limit reached (weekly limit)',
    resume: 'r',
  })
  const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': stopped } })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — stopped: usage limit reached \(weekly limit\)\. The run is in /)
  assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
  assert.deepEqual(logged(run), [])
})

for (const missing of ['report', 'verdict'])
  test(`a finished step that names no ${missing} is read back from the status`, async () => {
    const run = await runEngine('audit', {
      args: {},
      script: {
        'step:resolve': RESOLVED,
        'step:start': pending([LENS()]),
        [LENS_LABEL]: writes({}),
        'step:submit:1': done({ [missing]: undefined }),
        'step:status': done(),
      },
    })
    assert.match(command(run, 'step:status'), /^\/b\/craft audit status --run /)
    assert.match(run.report, /^## Audit\n\nVerdict: Warning/)
    assert.deepEqual(logged(run), [])
  })

test('a lost submit of a run still going stops it INCOMPLETE, filed under audit with the stop’s lines', async () => {
  const run = await runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([LENS()]),
      [LENS_LABEL]: writes({}),
      'step:submit:1': null,
      'step:status': ran({ run: RUN, phase: 'lens', pass: 1, done: false, tasks: [] }),
      'log-run': { ok: true },
    },
  })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — audit stopped \(the binary reports the lens phase\): /)
  const record = filedRecord(run)
  assert.equal(record?.name, 'audit')
  assert.equal(record?.verdict, 'INCOMPLETE')
  assert.deepEqual(record?.notRun, ['the craft binary did not finish the run', 'stopped: a step of the binary was lost'])
})

test('a lost submit of a finished pass whose record did not land has it filed again', async () => {
  const run = await runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([LENS()]),
      [LENS_LABEL]: writes({}),
      'step:submit:1': null,
      'step:status': done({ filing: { runDir: '', rejoin: false, lost: ['x'], record: 'failed' } }),
      'step:refile': done(),
    },
  })
  assert.equal(command(run, 'step:refile'), `/b/craft audit submit --run '${RUN}' --resume`)
  assert.doesNotMatch(run.report, /Telemetry lost/)
})

test('a lost submit of a run the binary stopped on the limit ends stopped, filed by no one here', async () => {
  const run = await runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending([LENS()]),
      [LENS_LABEL]: writes({}),
      'step:submit:1': null,
      'step:status': ran({ run: RUN, phase: 'lens', done: false, tasks: [], stopped: { cause: 'limit', text: 'weekly limit' } }),
      'log-run': { ok: true },
    },
  })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — stopped: usage limit reached \(weekly limit\)\. The run is in /)
  assert.deepEqual(logged(run), [])
})

test('a resumed run with no repository named that stops files no record, and says why', async () => {
  const run = await runEngine('audit', { args: { run: '/r/run-1' }, script: { 'step:resolve': RESOLVED, 'step:resume': null, 'log-run': { ok: true } } })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — audit stopped: .+\. The run is in \/r\/run-1\./)
  assert.ok(run.report.includes("No run record was filed: the resumed run's repository is unknown"), run.report)
  assert.deepEqual(logged(run), [])
})

test('an argument the binary refuses at the start is filed as a refusal, in the binary’s words', async () => {
  const run = await runEngine('audit', {
    args: { path: 'nowhere' },
    script: {
      'step:resolve': RESOLVED,
      'step:start': ran('', 2, 'craft: the path "nowhere" holds no tracked file'),
      'log-run': { ok: true },
    },
  })
  assert.match(run.report, /INCOMPLETE — audit: the path "nowhere" holds no tracked file\. Nothing ran\./)
  assert.deepEqual(filedRecord(run)?.notRun, ['an argument value audit cannot use was refused, nothing ran'])
})

for (const [name, args] of Object.entries({
  'an argument the engine does not take': { base: 'main' },
  'a budget of zero': { batchBytes: 0 },
  'a budget that is no whole number': { lensAgents: '1.5' },
  'a path holding a control character': { path: 'src\nrm' },
  'a blank path in a list': { path: ['src', ' '] },
  'a relative repo': { repo: 'rel' },
  'run= beside a start option': { run: '/r/run', path: 'src' },
}))
  test(`${name} is refused before any agent but the logger`, async () => {
    const run = await runEngine('audit', { args, script: { 'log-run': { ok: true } } })
    assert.deepEqual(labels(run), ['log-run'])
    assert.match(run.report, /^## Verdict\n⚠️ INCOMPLETE — /)
    assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE (argument refused)')
  })
