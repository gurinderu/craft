// The review driver over paged steps (integrations/shared/cli-review-steps.mjs, integrations/shared/cli-review-paged.mjs):
// a paged start and submit read through `craft review page --run`; and a page step that fails — whatever it exits with —
// read as a step not read whole on every path: a status falls back to the brief status when its page step failed or
// the harness refused it (not when the harness refused the status command itself or the page step stopped on the usage
// limit), a resume keeps its run and resume hint, a publication's outcome is unknown, and a start names the run it made.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filedRecord, runEngine } from './engine-harness.mjs'

let RUN = ''
/** The account's usage limit as a task agent says it (integrations/shared/cli-review-limit.mjs). */
const LIMIT = "You've hit your limit · resets 3am (Europe/Berlin)"
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

/** A service answer carrying `stdout`. @param {string} stdout */
const ran = stdout => ({ exitCode: 0, stdout, stderr: '' })
/** The page of `text` from `from`, `count` units long, as the binary prints it for the run. @param {string} text @param {number} from @param {number} count */
const page = (text, from, count) =>
  ran(`craft-out ${RUN} ${String(text.length)} ${String(from)} ${String(count)}\n${text.slice(from, from + count)}\ncraft-page ${String(from + count)}\n`)
/** A page command the binary refused, exiting `code`. @param {number} code */
const failed = code => ({ exitCode: code, stdout: '', stderr: `craft: the page failed with ${String(code)}` })
const TASK = () => ({ id: 'l', label: 'lens:a', model: 'opus', promptFile: `${RUN}/p.md`, schemaFile: `${RUN}/s.json`, answerFile: `${RUN}/a.json` })
const BASE = () => ({ 'step:root': ran('root=/plugin\n'), 'log-run': { ok: true, output: ['wrote /store/r.json'] } })
const ARGS = { craftBin: '/opt/craft', craftRoot: '/plugin' }

test('the driver reads a paged start and a paged submit through `craft review page --run` and goes on with each step', async () => {
  const start = JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })
  const done = JSON.stringify({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
  const half = (/** @type {string} */ text, /** @type {boolean} */ second) => {
    const at = Math.floor(text.length / 2)
    return second ? page(text, at, text.length - at) : page(text, 0, at)
  }
  const run = await runEngine('review', {
    args: ARGS,
    script: {
      ...BASE(),
      'step:start': half(start, false),
      'step:start:page': half(start, true),
      lens: 'done',
      'step:submit:1': half(done, false),
      'step:submit:1:page': half(done, true),
    },
  })
  assert.deepEqual(
    run.calls.map(c => c.label),
    ['step:root', 'step:start', 'step:start:page', 'lens:a', 'step:submit:1', 'step:submit:1:page'],
  )
  const pageCall = run.calls.find(c => c.label === 'step:submit:1:page')
  assert.match(String(pageCall?.prompt), new RegExp(`^/opt/craft review page --run '${RUN}' --from ${String(Math.floor(done.length / 2))}$`, 'm'))
  // A page is three lines, its body one line however long: the agent is told so.
  assert.match(
    String(pageCall?.prompt),
    /stdout is exactly three lines: the craft-out line, the page's one body line copied whole, character for character, never split, wrapped or trimmed/,
  )
  for (const label of ['step:start', 'step:submit:1']) {
    assert.match(
      String(run.calls.find(c => c.label === label)?.prompt),
      /stdout is either one line of JSON or, when the step is paged, exactly three lines/,
      label,
    )
  }
  assert.match(run.report, /^## Verdict\n\n⛔ Block/)
})

for (const code of [1, 2]) {
  test(`a start whose page step exits ${String(code)} names the run it made, and is no refused argument`, async () => {
    const start = JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })
    const run = await runEngine('review', { args: ARGS, script: { ...BASE(), 'step:start': page(start, 0, 5), 'step:start:page': failed(code) } })
    assert.ok(run.report.includes(`The run is in ${RUN}`), run.report)
    assert.ok(run.report.includes(`the page failed with ${String(code)}`), run.report)
    assert.doesNotMatch(run.report, /No run was started|Nothing ran/)
  })
}

test('a start whose page step the harness refused names the run it made, not "No run was started"', async () => {
  const start = JSON.stringify({ run: RUN, done: false, tasks: [] })
  const refused = {
    exitCode: 1,
    stdout: '',
    stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page --run '${RUN}' --from 5 (timeout 120000 ms).`,
  }
  const run = await runEngine('review', { args: ARGS, script: { ...BASE(), 'step:start': page(start, 0, 5), 'step:start:page': refused } })
  assert.doesNotMatch(run.report, /No run was started/)
  assert.ok(run.report.includes(`The steps done so far are kept in ${RUN}`), run.report)
})

test('a resume whose page step fails keeps its run and its resume hint, never "cannot be resumed"', async () => {
  const step = JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })
  const run = await runEngine('review', {
    args: { ...ARGS, run: RUN },
    script: { ...BASE(), 'step:resume': page(step, 0, 5), 'step:resume:page': failed(1) },
  })
  assert.ok(run.report.includes(`craft:review run=${RUN}`), run.report)
  assert.doesNotMatch(run.report, /cannot be resumed/)
})

test('a publication whose page step fails says its outcome is unknown, never that nothing was posted', async () => {
  const step = JSON.stringify({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
  const run = await runEngine('review', {
    args: { ...ARGS, run: RUN, comment: true },
    script: { ...BASE(), 'step:comment': page(step, 0, 5), 'step:comment:page': failed(1) },
  })
  assert.match(run.report, /whether anything was posted on the PR is unknown/)
  assert.ok(run.report.includes('it exited 1: craft: the page failed with 1'), run.report)
  assert.doesNotMatch(run.report, /Nothing was posted/)
})

// The page step's answers: a failed one is asked a second time before its step is given up; one the harness refused
// is not — the stop comes back at once (integrations/shared/cli-review-paged.mjs).
for (const [how, answer, asks] of /** @type {[string, () => unknown, number][]} */ ([
  ['fails', () => failed(1), 2],
  [
    'the harness refused',
    () => ({
      exitCode: 1,
      stdout: '',
      stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page --run '${RUN}' --from 5 (timeout 120000 ms).`,
    }),
    1,
  ],
])) {
  test(`a status whose page step ${how} falls back to the brief status, and files no INCOMPLETE record`, async () => {
    const status = JSON.stringify({ run: RUN, done: true, filing: { record: 'filed' } })
    const brief = JSON.stringify({
      run: RUN,
      brief: true,
      phase: 'done',
      round: 1,
      done: true,
      stopped: false,
      head: 'abc1234',
      verdict: 'Block',
      line: 'Block — 1 High',
      report: `${RUN}/report.md`,
      filing: { record: 'filed', recordFile: '/store/r.json', kept: true, pending: 0 },
    })
    const run = await runEngine('review', {
      args: ARGS,
      script: {
        ...BASE(),
        'step:start': ran(JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })),
        lens: 'done',
        'step:submit:1': ran('Error: the output was cut'),
        'step:status': page(status, 0, 5),
        'step:status:page': answer(),
        'step:brief': ran(brief),
      },
    })
    assert.deepEqual(
      run.calls.map(c => c.label),
      ['step:root', 'step:start', 'lens:a', 'step:submit:1', 'step:status', ...Array.from({ length: asks }, () => 'step:status:page'), 'step:brief'],
    )
    assert.match(
      String(run.calls.find(c => c.label === 'step:status')?.prompt),
      /stdout is either one line of JSON or, when the step is paged, exactly three lines/,
    )
    assert.match(run.report, /Block — 1 High/)
    assert.doesNotMatch(run.report, /did not finish the run/)
  })
}

for (const brief of [false, true])
  test(`a refused ${brief ? 'brief' : 'full'} status names the refusal without claiming an unfinished run`, async () => {
    const refused = {
      exitCode: 1,
      stdout: '',
      stderr: 'Permission for this action was denied by the Claude Code auto mode classifier. The command was not run.',
    }
    const run = await runEngine('review', {
      args: ARGS,
      script: {
        ...BASE(),
        'step:start': ran(JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })),
        lens: 'done',
        'step:submit:1': ran('Error: the output was cut'),
        'step:status': brief ? ran('cut status') : refused,
        'step:brief': refused,
      },
    })
    assert.deepEqual(
      run.calls.map(c => c.label),
      ['step:root', 'step:start', 'lens:a', 'step:submit:1', 'step:status', ...(brief ? ['step:brief'] : [])],
    )
    assert.match(run.report, /the harness's permission check refused the command, not craft/)
    assert.ok(run.report.includes(`/opt/craft review status --run '${RUN}'${brief ? ' --brief' : ' --paged'}`), run.report)
    assert.ok(run.report.includes('Bash(/opt/craft review:*)'), run.report)
    assert.ok(run.report.includes(`craft:review run=${RUN}`), run.report)
    assert.match(run.report, /whether the binary finished the run is unknown/)
    assert.match(run.report, /No run record was filed/)
    assert.equal(filedRecord(run), null)
  })

for (const brief of [false, true])
  for (const cause of ['lost', 'limit', 'refused'])
    test(`a failed ${brief ? 'brief' : 'full'} status retains the ${cause} submit cause and files nothing`, async () => {
      const refused = { exitCode: 1, stdout: '', stderr: 'Permission for this action was denied. The command was not run.' }
      const status = { exitCode: 124, stdout: '', stderr: 'status timed out' }
      const run = await runEngine('review', {
        args: ARGS,
        script: {
          ...BASE(),
          'step:start': ran(JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })),
          lens:
            cause === 'lost'
              ? 'done'
              : () => {
                  throw new Error(LIMIT)
                },
          'step:submit:1': cause === 'refused' ? refused : ran('cut submit'),
          'step:status': brief ? ran('cut status') : status,
          'step:brief': status,
        },
      })
      assert.match(run.report, /Status recovery failed:.*the command exited 124: status timed out/)
      assert.ok(run.report.includes(`/opt/craft review status --run '${RUN}'${brief ? ' --brief' : ' --paged'}`), run.report)
      if (cause === 'limit') assert.ok(run.report.includes(`stopped: usage limit reached (${LIMIT})`), run.report)
      else if (cause === 'refused') assert.match(run.report, /the harness's permission check refused the command, not craft.*review submit/)
      else assert.match(run.report, /the command printed no JSON: cut submit/)
      assert.match(run.report, /No run record was filed: whether the binary finished the run is unknown/)
      assert.equal(filedRecord(run), null)
      assert.equal(run.calls.filter(c => c.label === 'step:brief').length, brief ? 1 : 0)
    })

for (const recovery of ['page', 'status', 'brief', 'pending'])
  for (const submit of ['unreadable', 'empty'])
    test(`a ${recovery} status keeps the usage limit after an ${submit} submit`, async () => {
      const status = JSON.stringify({ run: RUN, done: true, filing: { record: 'filed' } })
      const run = await runEngine('review', {
        args: ARGS,
        script: {
          ...BASE(),
          'step:start': ran(JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })),
          lens: () => {
            throw new Error(LIMIT)
          },
          'step:submit:1': submit === 'empty' ? null : ran('Error: the output was cut'),
          'step:status':
            recovery === 'page'
              ? page(status, 0, 5)
              : recovery === 'brief'
                ? ran('Error: status was cut')
                : recovery === 'pending'
                  ? ran(JSON.stringify({ run: RUN, done: false, round: 2, phase: 'lenses' }))
                  : null,
          // The service agent answers nothing once the limit is seen: the page step comes back as the limit's stop.
          'step:status:page': () => null,
          'step:brief': () => null,
        },
      })
      assert.ok(
        run.logs.some(l => l.startsWith(`⛔ usage limit reached (${LIMIT})`)),
        run.logs.join('\n'),
      )
      const extra = recovery === 'page' ? ['step:status:page'] : recovery === 'brief' ? ['step:brief'] : []
      assert.deepEqual(
        run.calls.map(c => c.label),
        ['step:root', 'step:start', 'lens:a', 'step:submit:1', 'step:status', ...extra, 'log-run'],
      )
      assert.ok(run.report.includes(`stopped: usage limit reached (${LIMIT})`), run.report)
      assert.ok(run.report.includes(`The run is in ${RUN}. To resume`), run.report)
      assert.ok(run.report.includes(`craft review submit --run '${RUN}' --resume`), run.report)
      assert.equal(run.report.includes('the binary reports round 2, phase lenses'), recovery === 'pending')
      assert.doesNotMatch(run.report, /review stopped:|the command printed no JSON/)
      assert.deepEqual(filedRecord(run)?.notRun, ['the craft binary did not finish the run', 'stopped: the usage limit was reached'])
    })

test('a recovered binary ending takes precedence over the limit seen by the driver', async () => {
  const finished = { run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' }
  const run = await runEngine('review', {
    args: ARGS,
    script: {
      ...BASE(),
      'step:start': ran(JSON.stringify({ run: RUN, done: false, tasks: [TASK()] })),
      lens: () => {
        throw new Error(LIMIT)
      },
      'step:submit:1': ran('cut JSON'),
      'step:status': ran(JSON.stringify({ run: RUN, done: true, filing: { record: 'filed', finished } })),
    },
  })
  assert.match(run.report, /^## Verdict\n\n⛔ Block/)
  assert.equal(filedRecord(run), null, 'the driver must not write INCOMPLETE over the binary’s ending')
})

test('a publication whose page step the harness refused says its outcome is unknown: the comment itself ran', async () => {
  const step = JSON.stringify({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
  const refused = {
    exitCode: 1,
    stdout: '',
    stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page --run '${RUN}' --from 5 (timeout 120000 ms).`,
  }
  const run = await runEngine('review', {
    args: { ...ARGS, run: RUN, comment: true },
    script: { ...BASE(), 'step:comment': page(step, 0, 5), 'step:comment:page': refused },
  })
  assert.match(run.report, /whether anything was posted on the PR is unknown/)
  assert.ok(run.report.includes("the harness's permission check refused the command"), run.report)
  assert.doesNotMatch(run.report, /Nothing was posted/)
})

test('a comment command the harness refused itself posted nothing, and says so', async () => {
  const refused = {
    exitCode: 1,
    stdout: '',
    stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review comment --run '${RUN}' (timeout 420000 ms).`,
  }
  const run = await runEngine('review', { args: { ...ARGS, run: RUN, comment: true }, script: { ...BASE(), 'step:comment': refused } })
  assert.match(run.report, /Nothing was posted on the PR — the harness's permission check refused the command/)
})
