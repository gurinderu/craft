// A paged step read whole (integrations/shared/cli-review-paged.mjs): its pages joined with no separator, every count
// checked, a cut page asked again from the file and never the command, a page of another step refused, a stopped page
// step passed on; and the review driver reading a paged start and submit through `craft review page`.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PAGES, pageOf, readPaged } from './cli-review-paged.mjs'
import { commandOutput } from './cli-review-step.mjs'
import { runEngine } from './engine-harness.mjs'

const FILE = '/run/host-step.out'
/** A step whose strings end in a comma, hold `,"` and characters of every width — 🦀 is two UTF-16 units. */
const STEP = JSON.stringify({ run: '/run', note: 'a, "b",', label: 'é — 🦀 ,', done: false, tasks: [] })

/** The page of `text` from `from`, `count` units long, as the binary prints it. @param {string} text @param {number} from @param {number} count @param {string} [file] */
const page = (text, from, count, file = FILE) =>
  `craft-out ${file} ${String(text.length)} ${String(from)} ${String(count)}\n${text.slice(from, from + count)}\ncraft-page ${String(from + count)}\n`
/** A service answer carrying `stdout`. @param {string} stdout */
const ran = stdout => ({ exitCode: 0, stdout, stderr: '' })
/** The command output of a read answer, '' when there is none. @param {unknown} got */
const stdoutOf = got => {
  const out = commandOutput(got)
  return 'stdout' in out ? out.stdout : ''
}
/** The error a read answer carries, '' when it has output. @param {unknown} got */
const errorOf = got => {
  const out = commandOutput(got)
  return 'error' in out ? out.error : ''
}
/** An `ask` that answers each offset with the page of `text` from it, `size` units long. @param {string} text @param {number} size @param {number[]} asked */
const pager = (text, size, asked) => async (/** @type {string} */ file, /** @type {number} */ from) => {
  asked.push(from)
  assert.equal(file, FILE)
  return ran(page(text, from, Math.min(size, text.length - from)))
}

test('a page is read only whole: its frame, its offset and every count holding', () => {
  assert.deepEqual(pageOf(page(STEP, 5, 7), 5), { file: FILE, total: STEP.length, from: 5, body: STEP.slice(5, 12), end: 12 })
  assert.equal(pageOf(page(STEP, 5, 7), 4), null, 'another offset than the one asked')
  assert.equal(pageOf(page(STEP, 0, 7).replace(/craft-page 7\n$/, ''), 0), null, 'cut before its last line')
  assert.equal(pageOf(page(STEP, 0, 7).replace(STEP.slice(0, 7), STEP.slice(0, 6)), 0), null, 'a character dropped')
  assert.equal(pageOf(page(STEP, 0, 7).replace('craft-page 7', 'craft-page 8'), 0), null, 'an end that is not from + count')
  assert.equal(pageOf(page(STEP, 0, 7, 'host-step.out'), 0), null, 'a file that is no absolute path')
  assert.equal(pageOf(`${page(STEP, 0, 7)}junk\n`, 0), null, 'a line after its closing line')
})

test('an answer that is not paged comes back as it is', async () => {
  /** @type {number[]} */
  const asked = []
  for (const got of [ran('{"run":"/r"}'), { exitCode: 1, stdout: '', stderr: 'craft: no run' }, null, { limit: 'x' }]) {
    assert.equal(await readPaged(got, pager(STEP, 4, asked)), got)
  }
  assert.equal(asked.length, 0)
})

test('the pages join with no separator into the step, commas, quotes and wide characters across their edges', async () => {
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(page(STEP, 0, 9)), pager(STEP, 9, asked))
  assert.equal(stdoutOf(got), STEP)
  assert.deepEqual(JSON.parse(stdoutOf(got)), JSON.parse(STEP))
  assert.deepEqual(
    asked,
    Array.from({ length: Math.ceil(STEP.length / 9) - 1 }, (_, i) => (i + 1) * 9),
  )
})

test('a page cut once is asked again; cut twice, the step is said cut, never parsed', async () => {
  let n = 0
  const once = await readPaged(ran(page(STEP, 0, 20)), async (_file, from) =>
    n++ === 0 ? ran(`craft-out ${FILE} ${String(STEP.length)} ${String(from)} 30\n${STEP.slice(from, from + 12)}`) : ran(page(STEP, from, STEP.length - from)),
  )
  assert.equal(n, 2)
  assert.equal(stdoutOf(once), STEP)
  const twice = await readPaged(ran(page(STEP, 0, 20)), async () => ran(`craft-out ${FILE} ${String(STEP.length)}`))
  assert.equal(errorOf(twice), `the command's output could not be read whole: its page from offset 20 of ${FILE} came back cut twice`)
})

test('a page of another step — another file or length — is no page of this one', async () => {
  const other = `${STEP}x`
  for (const ask of [async () => ran(page(STEP, 20, STEP.length - 20, '/elsewhere/host-step.out')), async () => ran(page(other, 20, other.length - 20))]) {
    assert.match(errorOf(await readPaged(ran(page(STEP, 0, 20)), ask)), /came back cut twice$/)
  }
})

test('a first page cut is read again from the file it names', async () => {
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(`craft-out ${FILE} ${String(STEP.length)} 0 9\n{"ru`), pager(STEP, 40, asked))
  assert.equal(asked[0], 0)
  assert.equal(stdoutOf(got), STEP)
})

test('a frame naming no absolute file, or a page that moves nothing, is said cut', async () => {
  assert.equal(
    errorOf(await readPaged(ran('craft-out host-step.out 3 0 3\n{}x\ncraft-page 3\n'), async () => ran(''))),
    "the command's output could not be read whole: its first page named no file",
  )
  let n = 0
  const empty = await readPaged(ran(page(STEP, 0, 9)), async (_file, from) => {
    n++
    return ran(page(STEP, from, 0))
  })
  assert.equal(n, 2, 'an empty page is asked once more, then given up')
  assert.match(errorOf(empty), /its page from offset 9 of \/run\/host-step\.out came back cut twice$/)
})

test('a step past the page bound is given up, not read for ever', async () => {
  const long = 'y'.repeat(MAX_PAGES + 5)
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(page(long, 0, 1)), async (_file, from) => {
    asked.push(from)
    return ran(page(long, from, 1))
  })
  assert.equal(asked.length, MAX_PAGES - 1)
  assert.equal(errorOf(got), `the command's output could not be read whole: it ran past ${String(MAX_PAGES)} pages`)
})

test('a page step stopped by the usage limit or refused by the harness is passed on as it is', async () => {
  const limit = { limit: "You've hit your limit" }
  assert.deepEqual(await readPaged(ran(page(STEP, 0, 9)), async () => limit), { ...limit, pagedRun: '/run' })
  const refused = {
    exitCode: 1,
    stdout: '',
    stderr:
      'Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page (timeout 120000 ms).',
  }
  assert.deepEqual(await readPaged(ran(page(STEP, 0, 9)), async () => refused), { ...refused, pagedRun: '/run' })
  // The binary refusing the page command is not a cut page: asked once, its own reason kept.
  let n = 0
  const binary = { exitCode: 1, stdout: '', stderr: 'craft: offset 9 is no character boundary of the 70' }
  const got = await readPaged(ran(page(STEP, 0, 9)), async () => {
    n++
    return binary
  })
  assert.equal(n, 1)
  assert.equal(errorOf(got), 'the command exited 1: craft: offset 9 is no character boundary of the 70')
})

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

test('the driver reads a paged start and a paged submit through `craft review page` and goes on with each step', async () => {
  const file = `${RUN}/host-step.out`
  const task = { id: 'l', label: 'lens:a', model: 'opus', promptFile: `${RUN}/p.md`, schemaFile: `${RUN}/s.json`, answerFile: `${RUN}/a.json` }
  const start = JSON.stringify({ run: RUN, done: false, tasks: [task] })
  const done = JSON.stringify({ run: RUN, done: true, report: `${RUN}/report.md`, verdict: 'Block' })
  const half = (/** @type {string} */ text, /** @type {boolean} */ second) => {
    const at = Math.floor(text.length / 2)
    return ran(second ? page(text, at, text.length - at, file) : page(text, 0, at, file))
  }
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin' },
    script: {
      'step:root': ran('root=/plugin\n'),
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
  assert.match(String(pageCall?.prompt), new RegExp(`^/opt/craft review page --file '${file}' --from ${String(Math.floor(done.length / 2))}$`, 'm'))
  // A page is three lines, its body one line however long: the agent is told so.
  assert.match(
    String(pageCall?.prompt),
    /stdout is exactly three lines — the craft-out line, the page's one body line copied whole, character for character, never split, wrapped or trimmed/,
  )
  assert.match(run.report, /^## Verdict\n\n⛔ Block/)
})

test('pages that run past the length the first page named are said cut', async () => {
  const total = STEP.length
  const got = await readPaged(ran(page(STEP, 0, total - 2)), async (_file, from) =>
    ran(`craft-out ${FILE} ${String(total)} ${String(from)} 5\nabcde\ncraft-page ${String(from + 5)}\n`),
  )
  assert.equal(errorOf(got), `the command's output could not be read whole: it came to ${String(total + 3)} of ${String(total)} characters`)
})

test('a start whose page step the harness refused names the run it made, not "No run was started"', async () => {
  const file = `${RUN}/host-step.out`
  const start = JSON.stringify({ run: RUN, done: false, tasks: [] })
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin' },
    script: {
      'step:root': ran('root=/plugin\n'),
      'step:start': ran(page(start, 0, 5, file)),
      'step:start:page': {
        exitCode: 1,
        stdout: '',
        stderr: `Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page --file '${file}' --from 5 (timeout 120000 ms).`,
      },
      'log-run': { ok: true, output: ['wrote /store/r.json'] },
    },
  })
  assert.doesNotMatch(run.report, /No run was started/)
  assert.ok(run.report.includes(`The steps done so far are kept in ${RUN}`), run.report)
})
