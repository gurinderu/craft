// The audit engine (integrations/claude-code/src/audit.js, integrations/shared/cli-audit-steps.mjs) driven end to end with
// scripted agents (integrations/shared/audit-engine-script.mjs): the start with the engine's arguments and the plugin
// root its prompts name, the lens and verifier tasks told where their files are, and the answer — the verdict, where the
// report is, never the report copied, and the counts of what the pass left; a pass that left files unread or findings
// unjudged never reads as clean (realm @nick/craft, node #588). Resumes and lost steps: cli-audit-resume.test.mjs;
// refusals: cli-audit-refusal.test.mjs.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEngine } from './engine-harness.mjs'
import { LENS_LABEL, RESOLVED, VERSION, command, done, lens, logged, pending, ran, verify, writes } from './audit-engine-script.mjs'

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-audit-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

test('a run gets the binary, starts with the engine’s arguments, runs the lens then verifier tasks and names the report', async () => {
  const run = await runEngine('audit', {
    args: { path: ['src', 'lib dir'], batchBytes: 5000, lensAgents: '3', repo: '/work/repo' },
    script: {
      'step:resolve': RESOLVED,
      'step:start': pending(RUN, [lens(RUN)]),
      [LENS_LABEL]: writes({ findings: [] }),
      'step:submit:1': pending(RUN, [verify(RUN)], 'verify'),
      'verify 1 rust finding(s)': writes({ verdicts: [] }),
      'step:submit:2': done(RUN, { unverifiedLow: { count: 2, file: `${RUN}/unverified.md` } }),
    },
  })
  assert.equal(
    command(run, 'step:start'),
    `/b/craft audit start --cwd '/work/repo' --path='src' --path='lib dir' --batch-bytes '5000' --lens-agents '3' --craft-root '/p/craft' --record '${VERSION}' --record-root '/p/craft'`,
  )
  assert.equal(command(run, 'step:submit:2'), `/b/craft audit submit --run '${RUN}'`)
  assert.equal(run.calls.find(c => c.label === LENS_LABEL)?.opts.model, 'sonnet', 'the lens task runs on the model the binary named')
  assert.equal(run.calls.find(c => c.label.startsWith('verify'))?.opts.model, 'opus', 'the verifier runs on the model the binary named')
  assert.match(run.report, new RegExp(`^## Audit\\n\\nVerdict: Warning\\n\\nThe report is ${RUN}/report\\.md — read that file for the findings`))
  assert.ok(run.report.includes('Counts: unread=0 file(s), unjudged=0 finding(s), unverifiedLow=2 finding(s).'), run.report)
  assert.ok(run.report.includes(`The unverified Low and Info findings are listed in ${RUN}/unverified.md.`), run.report)
  assert.ok(run.report.includes('craft:addressing-findings'), run.report)
  assert.doesNotMatch(run.report, /INCOMPLETE|run=/, 'a clean pass offers no resume')
  assert.deepEqual(logged(run), [], 'the binary files a finished pass’s record itself')
})

for (const [name, args, script, tail] of /** @type {[string, Record<string, unknown>, Record<string, unknown>, string][]} */ ([
  ['nothing given, the released binary', {}, {}, ` --craft-root '/p/craft' --record '${VERSION}' --record-root '/p/craft'`],
  [
    'a local build with its plugin root, checked',
    { craftBin: '/b/craft', craftRoot: '/r/craft' },
    { 'step:root': ran('root=/r/craft\n') },
    ` --craft-root '/r/craft' --record '${VERSION}' --record-root '/r/craft'`,
  ],
  [
    'a local build alone: its prompts name the root above it, the record the one located',
    { craftBin: '/b/craft' },
    { 'step:locate': ran('root=/l/craft\n') },
    ` --record '${VERSION}' --record-root '/l/craft'`,
  ],
]))
  test(`the start names the plugin root its prompts read the skills under — ${name}`, async () => {
    const run = await runEngine('audit', { args, script: { 'step:resolve': RESOLVED, ...script, 'step:start': done(RUN, { verdict: 'Approve' }) } })
    assert.equal(command(run, 'step:start'), `/b/craft audit start${tail}`)
    assert.match(run.report, /^## Audit\n\nVerdict: Approve\n\n/)
  })

test('a pass the binary ended INCOMPLETE says so first, names the unread file and how to go on, and is filed by no one here', async () => {
  const more = { verdict: 'Block (INCOMPLETE)', unread: { count: 3, file: `${RUN}/unread.txt` }, unjudged: 1, resume: 'r' }
  const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': done(RUN, more) } })
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
    const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': done(RUN, more) } })
    assert.ok(run.report.startsWith(`## Audit\n\n⚠️ INCOMPLETE — verdict ${more.verdict}: `), run.report)
    assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
  })

test('a record the binary could not land is said, with how to file it again', async () => {
  const filing = { runDir: '', rejoin: false, lost: ['the run record — the index lock stayed taken'], record: 'failed' }
  const run = await runEngine('audit', { args: {}, script: { 'step:resolve': RESOLVED, 'step:start': done(RUN, { verdict: 'Approve', resume: 'r', filing }) } })
  assert.match(run.report, /^## Audit\n\nVerdict: Approve\n\n/)
  assert.match(run.report, /Telemetry lost[\s\S]*the run record — the index lock stayed taken/)
  assert.ok(run.report.includes(`craft:audit run=${RUN}`), run.report)
})
