// A resume (`run=`) whose own output the driver could not read may still have finished the run and filed its record
// (integrations/shared/cli-review-steps.mjs, opening and afterLost): the binary's status is asked before the driver files
// anything, as after a lost submit (realm @nick/craft, nodes #731, #736).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const RUN = '/tmp/run-r'
const REFUSED = 'Permission for this action was denied. The command was not run.'

/** @param {boolean} done */
const statusSays = done => {
  const finished = done
    ? {
        run: RUN,
        done: true,
        report: `${RUN}/report.md`,
        verdict: 'Block',
        line: 'Block',
        head: 'abc1234',
        notRun: [],
        filing: { runDir: '', rejoin: false, lost: [], record: 'filed', recordFile: '/store/r.json' },
      }
    : null
  const status = {
    run: RUN,
    phase: done ? 'done' : 'verify',
    done,
    ...(done ? { verdict: 'Block', report: `${RUN}/report.md` } : {}),
    filing: { record: done ? 'filed' : 'none', recordFile: done ? '/store/r.json' : '', finished, pending: 0 },
  }
  return { exitCode: 0, stderr: '', stdout: JSON.stringify(status) }
}

/** @param {Record<string, unknown>} script */
const lostResume = script =>
  runEngine('review', {
    args: { craftBin: '/opt/craft', run: RUN, repo: '/work/repo' },
    script: {
      'step:locate': { exitCode: 0, stdout: 'root=/opt/plugin\n', stderr: '' },
      'step:resume': { exitCode: 0, stderr: '', stdout: 'Error: the output was cut' },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
      ...script,
    },
  })

/** @param {{ calls: Array<{ label: string }> }} run */
const labels = run => run.calls.map(c => c.label)

test('a lost resume whose run the binary finished and filed ends as the binary left it, with no second record', async () => {
  const run = await lostResume({ 'step:status': statusSays(true) })
  assert.deepEqual(labels(run), ['step:locate', 'step:resume', 'step:status'])
  assert.match(run.report, /^## Verdict\n\n⛔ Block/, run.report)
  assert.ok(run.calls.find(c => c.label === 'step:status')?.prompt.includes(`--run '${RUN}'`), 'the status of the resumed run itself')
})

test('a lost resume whose run the binary did not finish stops where the binary says, and files the INCOMPLETE record', async () => {
  const run = await lostResume({ 'step:status': statusSays(false) })
  assert.deepEqual(labels(run), ['step:locate', 'step:resume', 'step:status', 'log-run'])
  assert.match(run.report, /review stopped \(the binary reports [^)]*verify[^)]*\): the command printed no JSON/, run.report)
  assert.ok(run.report.includes(`craft:review run=${RUN}`), run.report)
  /** @type {{ notRun?: unknown } | null} */
  const rec = JSON.parse(String(run.calls.find(c => c.label === 'log-run')?.prompt).split(/\nRECORD:\n/)[1] ?? 'null')
  assert.deepEqual(rec?.notRun, ['the craft binary did not finish the run', 'stopped: a step of the binary was lost'], 'the resume ran: its step was lost')
})

for (const refused of [false, true])
  test(`a lost resume whose status ${refused ? 'the harness refused' : 'failed'} leaves completion unknown and files nothing`, async () => {
    const run = await lostResume({ 'step:status': { exitCode: 1, stdout: '', stderr: refused ? REFUSED : 'cannot read state' } })
    assert.ok(!labels(run).includes('log-run'), String(labels(run)))
    assert.match(run.report, /whether the binary finished the run is unknown/)
    assert.match(run.report, /the command printed no JSON/, "the resume's own failure kept")
    assert.match(
      run.report,
      refused ? /the harness's permission check refused the command, not craft/ : /Status recovery failed:.*the command exited 1: cannot read state/,
    )
  })

test('a resume the binary refused, or the harness never ran, asks no status', async () => {
  const binary = await lostResume({ 'step:resume': { exitCode: 1, stdout: '', stderr: 'craft: reading the run state /tmp/run-r/state.json' } })
  assert.match(binary.report, /cannot be resumed: reading the run state/)
  const harness = await lostResume({ 'step:resume': { exitCode: 1, stdout: '', stderr: REFUSED } })
  assert.match(harness.report, /the harness's permission check refused the command, not craft/)
  for (const run of [binary, harness]) assert.ok(!labels(run).includes('step:status'), String(labels(run)))
})

test('a start whose step was lost asks no status: no run of its own is known to resume', async () => {
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft', repo: '/work/repo' },
    script: {
      'step:locate': { exitCode: 0, stdout: 'root=/opt/plugin\n', stderr: '' },
      'step:start': { exitCode: 0, stderr: '', stdout: 'Error: the output was cut' },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
    },
  })
  assert.ok(!labels(run).includes('step:status'), String(labels(run)))
  assert.match(run.report, /review stopped: the command printed no JSON/)
})

test('a resume whose first page named its run but whose page step the harness refused still asks the status', async () => {
  const step = JSON.stringify({ run: RUN, done: false, tasks: [] })
  const run = await lostResume({
    'step:resume': { exitCode: 0, stderr: '', stdout: `craft-out ${RUN} ${String(step.length)} 0 5\n${step.slice(0, 5)}\ncraft-page 5\n` },
    'step:resume:page': { exitCode: 1, stdout: '', stderr: REFUSED },
    'step:status': statusSays(true),
  })
  assert.ok(labels(run).includes('step:status'), String(labels(run)))
  assert.ok(!labels(run).includes('log-run'), 'no second record beside the binary’s own')
  assert.match(run.report, /^## Verdict\n\n⛔ Block/, run.report)
})

/** A start whose first page named its run and whose next page was not read. @param {Record<string, unknown>} script */
const lostStartPage = script => {
  const step = JSON.stringify({ run: RUN, done: false, tasks: [] })
  return runEngine('review', {
    args: { craftBin: '/opt/craft', repo: '/work/repo' },
    script: {
      'step:locate': { exitCode: 0, stdout: 'root=/opt/plugin\n', stderr: '' },
      'step:start': { exitCode: 0, stderr: '', stdout: `craft-out ${RUN} ${String(step.length)} 0 5\n${step.slice(0, 5)}\ncraft-page 5\n` },
      'step:start:page': { exitCode: 1, stdout: '', stderr: REFUSED },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
      ...script,
    },
  })
}

test('a start whose first page named its run but whose next page was not read asks the status of that run', async () => {
  const run = await lostStartPage({ 'step:status': statusSays(true) })
  assert.ok(labels(run).includes('step:status'), String(labels(run)))
  assert.ok(run.calls.find(c => c.label === 'step:status')?.prompt.includes(`--run '${RUN}'`), 'the status of the run the page named')
  assert.ok(!labels(run).includes('log-run'), 'no second record beside the binary’s own')
  assert.match(run.report, /^## Verdict\n\n⛔ Block/, run.report)
})

test('a start whose named run the binary did not finish files one INCOMPLETE record and offers its resume', async () => {
  const run = await lostStartPage({ 'step:status': statusSays(false) })
  assert.equal(labels(run).filter(l => l === 'log-run').length, 1, String(labels(run)))
  assert.ok(run.report.includes(`craft:review run=${RUN}`), run.report)
})
