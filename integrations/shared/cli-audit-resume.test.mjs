// The audit engine's resumes and lost steps (integrations/shared/cli-step-driver.mjs over `craft audit`), scripted by
// integrations/shared/audit-engine-script.mjs: run= resumes with `submit --resume`; a run stopped on the usage limit
// says how to resume and is filed by no one here; a step that cannot be read is read back from the binary's status, in
// the shape `craft audit status` prints, before anything is filed (realm @nick/craft, node #588).
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filedRecord, runEngine } from './engine-harness.mjs'
import { LENS_LABEL, RESOLVED, command, done, endedStatus, goingStatus, lens, logged, pending, ran, writes } from './audit-engine-script.mjs'

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-audit-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

/** A run whose lens round answered and whose submit then printed `submit`, its status `status`. @param {unknown} submit @param {unknown} status @param {Record<string, unknown>} [more] */
const lostAfterLens = (submit, status, more = {}) =>
  runEngine('audit', {
    args: {},
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending(RUN, [lens(RUN)]),
      [LENS_LABEL]: writes({}),
      'step:submit:1': submit,
      'step:status': status,
      'log-run': { ok: true },
      ...more,
    },
  })

test('run= resumes the run with the binary’s submit --resume, never a start', async () => {
  const run = await runEngine('audit', { args: { run: '/r/run-1', repo: '/work/repo' }, script: { 'step:resolve': RESOLVED, 'step:resume': done('/r/run-1') } })
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
    const run = await lostAfterLens(done(RUN, { [missing]: undefined }), endedStatus(RUN))
    assert.match(command(run, 'step:status'), /^\/b\/craft audit status --run /)
    assert.match(run.report, /^## Audit\n\nVerdict: Warning/)
    assert.deepEqual(logged(run), [])
  })

test('a lost submit of a pass that left a finding unjudged reads INCOMPLETE from the status', async () => {
  const run = await lostAfterLens(null, endedStatus(RUN, { verdict: 'INCOMPLETE', unjudged: 2, resume: 'r' }))
  assert.ok(run.report.startsWith('## Audit\n\n⚠️ INCOMPLETE — verdict INCOMPLETE: '), run.report)
  assert.ok(run.report.includes('unjudged=2 finding(s)'), run.report)
  assert.deepEqual(logged(run), [])
})

test('a lost submit of a run still going stops it INCOMPLETE, filed under audit with the stop’s lines', async () => {
  const run = await lostAfterLens(null, goingStatus(RUN))
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — audit stopped \(the binary reports the lens phase\): /)
  const record = filedRecord(run)
  assert.deepEqual([record?.name, record?.verdict], ['audit', 'INCOMPLETE'])
  assert.deepEqual(record?.notRun, ['the craft binary did not finish the run', 'stopped: a step of the binary was lost'])
})

test('a lost submit of a finished pass whose record did not land has it filed again', async () => {
  const run = await lostAfterLens(null, endedStatus(RUN, { filing: { pass: 1, record: 'failed', file: '', lost: ['x'] } }), { 'step:refile': done(RUN) })
  assert.equal(command(run, 'step:refile'), `/b/craft audit submit --run '${RUN}' --resume`)
  assert.doesNotMatch(run.report, /Telemetry lost/)
})

test('a lost submit of a run the binary stopped on the limit ends stopped, filed by no one here', async () => {
  const run = await lostAfterLens(null, goingStatus(RUN, { stopped: { cause: 'limit', text: 'weekly limit' } }))
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — stopped: usage limit reached \(weekly limit\)\. The run is in /)
  assert.deepEqual(logged(run), [])
})

test('a resumed run with no repository named that stops files no record, and says why', async () => {
  const run = await runEngine('audit', { args: { run: '/r/run-1' }, script: { 'step:resolve': RESOLVED, 'step:resume': null, 'log-run': { ok: true } } })
  assert.match(run.report, /^## Audit\n\n⚠️ INCOMPLETE — audit stopped: .+\. The run is in \/r\/run-1\./)
  assert.ok(run.report.includes("No run record was filed: the resumed run's repository is unknown"), run.report)
  assert.deepEqual(logged(run), [])
})
