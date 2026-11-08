// The cli-review driver's `path` scope and its stop on the account's usage limit (lib/cli-review-limit.mjs,
// lib/cli-review-steps.mjs), driven with scripted agents as lib/cli-review-engine.test.mjs drives the loop; and the
// driver's `## Verdict` answer read back the way rust-audit reads a nested review's (lib/rust-audit-verdict.mjs).
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEngine } from './engine-harness.mjs'
import { limitWatch } from './cli-review-limit.mjs'
import { limitInReport, deathsInReport } from './limit-report.mjs'
import { reviewResult } from './rust-audit-verdict.mjs'
import { finishedAnswer, stoppedAnswer } from './cli-review-verdict.mjs'

let RUN = ''
beforeEach(() => { RUN = mkdtempSync(join(tmpdir(), 'craft-run-')) })
afterEach(() => { rmSync(RUN, { recursive: true, force: true }) })

const LIMIT = "You've hit your limit · resets 3am (Europe/Berlin)"
const RATE = '429 Too Many Requests: rate limited, please try again'

/** @param {string} id @param {string} label */
const task = (id, label) => ({
  id, label, model: 'opus',
  promptFile: `${RUN}/tasks/${id}.md`, schemaFile: `${RUN}/tasks/${id}.schema.json`, answerFile: `${RUN}/answers/${id}.json`,
})
/** @param {unknown} value */
const ran = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
/** @param {object[]} tasks */
const pending = tasks => ran({ run: RUN, tasks, done: false })
/** The binary's finished step, its verdict line `line`. @param {string} verdict @param {string} line */
const finished = (verdict, line) => ran({ run: RUN, done: true, report: `${RUN}/report.md`, verdict, line })
const args = { repo: '/work/repo', craftBin: '/opt/craft' }
/** The prompt of the call labelled `label`. @param {{ calls: { label: string, prompt: string }[] }} run @param {string} label */
const promptOf = (run, label) => run.calls.find(c => c.label === label)?.prompt ?? ''

test('the watch: limit text thrown or answered short stops, a transient 429 does not, and no task is sent after it', async () => {
  const watch = limitWatch()
  const rate = watch.tasks(async () => { throw new Error(RATE) })
  await assert.rejects(rate('p'), /429/, 'an ordinary throw stands')
  assert.equal(watch.seen(), '')
  assert.equal(await watch.tasks(async () => 'done')('p'), 'done')
  assert.equal(await watch.tasks(async () => { throw new Error(`agent failed\n${LIMIT}`) })('p'), null)
  assert.equal(watch.seen(), LIMIT)
  let sent = 0
  assert.equal(await watch.tasks(async () => { sent++; return 'done' })('p'), null)
  assert.equal(sent, 0, 'no task agent is dispatched once the limit is seen')
  assert.equal(await watch.service(async () => 'ran')('p'), 'ran', 'the submit that reports it still runs')
  const short = limitWatch()
  assert.equal(await short.tasks(async () => LIMIT)('p'), null)
  assert.equal(short.seen(), LIMIT)
  const long = limitWatch()
  const report = `${'x'.repeat(400)}\n${LIMIT}`
  assert.equal(await long.tasks(async () => report)('p'), report, 'a long answer that talks about limits is no limit')
})

test('path= reaches the binary as --path; a path that is no string is refused before anything runs', async () => {
  const run = await runEngine('cli-review', {
    args: { ...args, path: 'crates/a' },
    script: { 'step:start': finished('Approve', 'Approve') },
  })
  assert.match(promptOf(run, 'step:start'), /'\/opt\/craft' review start --cwd '\/work\/repo' --path 'crates\/a'$/m)
  const refused = await runEngine('cli-review', { args: { ...args, path: ['crates/a'] }, script: {} })
  assert.match(refused.report, /INCOMPLETE — cli-review: path=\["crates\/a"\] is not a path\. Nothing ran\./)
  assert.equal(refused.calls.length, 0)
})

test('limit text from a task stops the run at once: the submit says --limit, and the answer carries the stop', async () => {
  const line = `INCOMPLETE — stopped: usage limit reached (${LIMIT}). Resume once the limit resets: \`craft review submit --run '${RUN}'\``
  const run = await runEngine('cli-review', {
    args,
    script: {
      'step:start': pending([task('lens-errors-r1', 'lens:errors'), task('lens-intent-r1', 'lens:intent')]),
      lens: () => { throw new Error(LIMIT) },
      'step:submit:1': finished('INCOMPLETE', line),
    },
  })
  const submit = promptOf(run, 'step:submit:1').split('\n\n')[1]
  assert.equal(submit, `'/opt/craft' review submit --run '${RUN}' --limit 'You'\\''ve hit your limit · resets 3am (Europe/Berlin)'`)
  assert.ok(run.logs.some(l => l.startsWith(`⛔ usage limit reached (${LIMIT})`)), run.logs.join('\n'))
  assert.equal(limitInReport(run.report), LIMIT, 'a parent reads the stop back from the answer')
  assert.equal(reviewResult('review:core', run.report).verdict, 'Warning')
})

test('a transient 429 is an ordinary death: no --limit, and the binary asks for the answer again', async () => {
  const lens = task('lens-errors-r1', 'lens:errors')
  const run = await runEngine('cli-review', {
    args,
    script: {
      'step:start': pending([lens]),
      lens: () => { throw new Error(RATE) },
      'step:submit:1': pending([lens]),
      'step:submit:2': finished('Approve', 'Approve'),
    },
  })
  assert.doesNotMatch(promptOf(run, 'step:submit:1'), /--limit/)
  assert.equal(run.calls.filter(c => c.label === 'lens:errors').length, 2, 'asked again')
})

/** The resume line an answer gives for the run in RUN. */
const hint = () => `the Workflow \`craft:cli-review run=${RUN}\`, or the binary \`craft review submit --run '${RUN}' --resume\``

test('a submit that dies on the limit itself stops the run with the limit note, the run directory and how to resume it', async () => {
  const run = await runEngine('cli-review', {
    args,
    script: {
      'step:start': pending([task('lens-errors-r1', 'lens:errors')]),
      lens: () => LIMIT,
      'step:submit:1': () => { throw new Error(LIMIT) },
    },
  })
  assert.equal(limitInReport(run.report), LIMIT, run.report)
  assert.ok(run.report.includes(`The run is in ${RUN}.`), run.report)
  assert.ok(run.report.includes(hint()), run.report)
})

test('a submit whose service agent comes back null — the limit\'s live form, no text — names the run and how to resume it', async () => {
  const run = await runEngine('cli-review', {
    args,
    script: {
      'step:start': pending([task('lens-errors-r1', 'lens:errors')]),
      lens: () => 'done',
      'step:submit:1': null,
    },
  })
  assert.match(run.report, /INCOMPLETE — cli-review stopped at round 2: the service agent returned no command output\./)
  assert.ok(run.report.includes(`The run is in ${RUN}.`), run.report)
  assert.ok(run.report.includes(hint()), run.report)
})

test('a resume whose service agent comes back null is no bad directory: it names the run, how to resume it, and files no record', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN },
    script: { 'step:resume': null },
  })
  assert.doesNotMatch(run.report, /not a craft run directory/)
  assert.match(run.report, /the service agent returned no command output/)
  assert.ok(run.report.includes(hint()), run.report)
  assert.ok(run.report.includes('No run record was filed: the resumed run\'s repository is unknown'), run.report)
  assert.ok(!run.calls.some(c => /^(checkpoint|log-run)/.test(c.label)), 'no record under the session checkout')
  const keyed = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN, repo: '/work/repo' },
    script: { 'step:resume': null, 'log-run': { ok: true, output: ['wrote /store/r.json'] } },
  })
  assert.ok(keyed.calls.some(c => c.label.startsWith('log-run') && c.prompt.includes('/work/repo')), 'filed under the repo given')
})

test('a resume whose own submit dies on the limit reports the limit and how to resume, not a bad directory', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN },
    script: { 'step:resume': () => { throw new Error(LIMIT) } },
  })
  assert.equal(limitInReport(run.report), LIMIT, run.report)
  assert.doesNotMatch(run.report, /not a craft run directory/)
  assert.ok(run.report.includes(hint()), run.report)
})

test('a resumed run is resumed with --resume, and its record keyed to the repository the run reviews', async () => {
  const run = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN },
    script: {
      'step:resume': ran({ run: RUN, tasks: [task('lens-errors-r1', 'lens:errors')], done: false, repo: '/work/other' }),
      lens: () => 'done',
      'step:submit:1': finished('Approve', 'Approve'),
      checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    },
  })
  assert.match(promptOf(run, 'step:resume'), / --resume$/m)
  assert.doesNotMatch(promptOf(run, 'step:submit:1'), /--resume/, 'only the resuming submit is marked')
  assert.ok(promptOf(run, 'checkpoint:start').includes('/work/other'), promptOf(run, 'checkpoint:start'))
  assert.ok(!promptOf(run, 'checkpoint:start').includes('/work/repo'))
})

test("rust-audit's reviewResult reads every answer the driver gives", () => {
  const base = { run: RUN, report: `${RUN}/report.md`, degraded: false }
  const read = (/** @type {string} */ answer) => reviewResult('review:core', answer)
  assert.equal(read(finishedAnswer({ ...base, verdict: 'Approve', line: 'Approve' })).verdict, 'Approve')
  assert.equal(read(finishedAnswer({ ...base, verdict: 'Block', line: 'Block' })).verdict, 'Block')
  assert.equal(read(finishedAnswer({ ...base, verdict: 'Warning', line: 'Warning' })).verdict, 'Warning')
  const partial = read(finishedAnswer({ ...base, verdict: 'Approve (PARTIAL COVERAGE)', line: 'Approve (PARTIAL COVERAGE) — 1 file(s) …' }))
  assert.equal(partial.verdict, 'Warning')
  const dead = finishedAnswer({ ...base, verdict: 'INCOMPLETE', line: "INCOMPLETE — stopped: every agent dispatched in lens round 1 died with no answer, most likely the account's usage limit or an outage. Resume once agents answer again: `craft review submit --run '/r'`" })
  assert.equal(read(dead).verdict, 'Warning')
  assert.match(read(dead).summary, /uncovered, not clean/)
  assert.equal(deathsInReport(dead), 'every agent dispatched in lens round 1 died with no answer')
  assert.equal(read(stoppedAnswer('cli-review stopped at round 1: the step names no run directory.')).verdict, 'Warning')
})

test('a run stopped on the limit, resumed through the driver with run=, reaches done', async () => {
  const lens = task('lens-errors-r1', 'lens:errors')
  const stoppedStep = ran({
    run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'INCOMPLETE',
    line: `INCOMPLETE — stopped: usage limit reached (${LIMIT}). Resume once the limit resets: \`craft review submit --run '${RUN}'\``,
    stopped: { cause: 'limit', text: LIMIT }, resume: `craft review submit --run '${RUN}'`,
  })
  const stopped = await runEngine('cli-review', {
    args,
    script: { 'step:start': pending([lens]), lens: () => { throw new Error(LIMIT) }, 'step:submit:1': stoppedStep },
  })
  assert.ok(stopped.report.includes(hint()), stopped.report)

  const resumed = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: RUN },
    script: {
      'step:resume': pending([lens]),
      lens: () => 'done',
      'step:submit:1': finished('Approve', 'Approve'),
    },
  })
  assert.equal(promptOf(resumed, 'step:start'), '', 'no new run is started')
  assert.equal(promptOf(resumed, 'step:resume').split('\n\n')[1], `'/opt/craft' review submit --run '${RUN}' --resume`)
  assert.equal(resumed.calls.filter(c => c.label === 'lens:errors').length, 1, 'the held task handed out again')
  assert.match(resumed.report, /^## Verdict\n\n✅ Approve\n/)
  assert.doesNotMatch(resumed.report, /To resume/)
})

test('run= that holds no craft run is refused with why; one that is no absolute path is refused before anything runs', async () => {
  const refused = await runEngine('cli-review', {
    args: { craftBin: '/opt/craft', run: '/tmp/not-a-run' },
    script: { 'step:resume': { exitCode: 1, stdout: '', stderr: 'craft: reading the run state /tmp/not-a-run/state.json' } },
  })
  assert.match(refused.report, /INCOMPLETE — cli-review stopped at round 1: run="\/tmp\/not-a-run" is not a craft run directory this binary can resume \(no state\.json of its current format, or a finished run\): the command exited 1: craft: reading the run state/)
  const relative = await runEngine('cli-review', { args: { craftBin: '/opt/craft', run: 'runs/x' }, script: {} })
  assert.match(relative.report, /run="runs\/x" is not an absolute path/)
  assert.equal(relative.calls.length, 0)
})
