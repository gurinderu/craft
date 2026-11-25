// A paged step read whole (integrations/shared/cli-review-paged.mjs): its pages joined with no separator, every count
// checked, a page that was not read asked again through `craft review page --run` and never the command run again, a
// page of another step refused, a stopped page step passed on, any other failed one read as the step unread. The
// driver over paged steps is integrations/shared/cli-review-paged-driver.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { MAX_PAGES, pageOf, readPaged } from './cli-review-paged.mjs'
import { commandOutput } from './cli-review-step.mjs'

const DIR = '/run'
/** A step whose strings end in a comma, hold `,"` and characters of every width — 🦀 is two UTF-16 units. */
const STEP = JSON.stringify({ run: '/run', note: 'a, "b",', label: 'é — 🦀 ,', done: false, tasks: [] })

/** The page of `text` from `from`, `count` units long, as the binary prints it. @param {string} text @param {number} from @param {number} count @param {string} [dir] */
const page = (text, from, count, dir = DIR) =>
  `craft-out ${dir} ${String(text.length)} ${String(from)} ${String(count)}\n${text.slice(from, from + count)}\ncraft-page ${String(from + count)}\n`
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
const pager = (text, size, asked) => async (/** @type {string} */ run, /** @type {number} */ from) => {
  asked.push(from)
  assert.equal(run, DIR)
  return ran(page(text, from, Math.min(size, text.length - from)))
}

test('a page is read only whole: its frame, its offset and every count holding', () => {
  assert.deepEqual(pageOf(page(STEP, 5, 7), 5), { run: DIR, total: STEP.length, from: 5, body: STEP.slice(5, 12), end: 12 })
  assert.equal(pageOf(page(STEP, 5, 7), 4), null, 'another offset than the one asked')
  assert.equal(pageOf(page(STEP, 0, 7).replace(/craft-page 7\n$/, ''), 0), null, 'cut before its last line')
  assert.equal(pageOf(page(STEP, 0, 7).replace(STEP.slice(0, 7), STEP.slice(0, 6)), 0), null, 'a character dropped')
  assert.equal(pageOf(page(STEP, 0, 7).replace('craft-page 7', 'craft-page 8'), 0), null, 'an end that is not from + count')
  assert.equal(pageOf(page(STEP, 0, 7, 'run'), 0), null, 'a run that is no absolute path')
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
  const once = await readPaged(ran(page(STEP, 0, 20)), async (_run, from) =>
    n++ === 0 ? ran(`craft-out ${DIR} ${String(STEP.length)} ${String(from)} 30\n${STEP.slice(from, from + 12)}`) : ran(page(STEP, from, STEP.length - from)),
  )
  assert.equal(n, 2)
  assert.equal(stdoutOf(once), STEP)
  const twice = await readPaged(ran(page(STEP, 0, 20)), async () => ran(`craft-out ${DIR} ${String(STEP.length)}`))
  assert.equal(
    errorOf(twice),
    `the command's output could not be read whole: its page from offset 20 of ${DIR} was not read twice: both tries: it came back cut`,
  )
})

test('a page of another step — another run or length — is no page of this one, and is said so', async () => {
  const other = `${STEP}x`
  const run = await readPaged(ran(page(STEP, 0, 20)), async () => ran(page(STEP, 20, STEP.length - 20, '/elsewhere')))
  assert.match(errorOf(run), /was not read twice: both tries: it was a page of another run \(\/elsewhere\)$/)
  const step = await readPaged(ran(page(STEP, 0, 20)), async () => ran(page(other, 20, other.length - 20)))
  assert.match(
    errorOf(step),
    new RegExp(`was not read twice: both tries: it was a page of another step \\(${String(other.length)} characters, not ${String(STEP.length)}\\)$`),
  )
})

test('a first page cut is read again from the run it names', async () => {
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(`craft-out ${DIR} ${String(STEP.length)} 0 9\n{"ru`), pager(STEP, 40, asked))
  assert.equal(asked[0], 0)
  assert.equal(stdoutOf(got), STEP)
})

test('a frame naming no absolute run directory, or a page that moves nothing, is said cut', async () => {
  assert.equal(
    errorOf(await readPaged(ran('craft-out run 3 0 3\n{}x\ncraft-page 3\n'), async () => ran(''))),
    "the command's output could not be read whole: its first page named no run directory",
  )
  let n = 0
  const empty = await readPaged(ran(page(STEP, 0, 9)), async (_run, from) => {
    n++
    return ran(page(STEP, from, 0))
  })
  assert.equal(n, 2, 'an empty page is asked once more, then given up')
  assert.match(errorOf(empty), /its page from offset 9 of \/run was not read twice: both tries: it moved on no character$/)
})

test('a step past the page bound is given up, not read for ever', async () => {
  const long = 'y'.repeat(MAX_PAGES + 5)
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(page(long, 0, 1)), async (_run, from) => {
    asked.push(from)
    return ran(page(long, from, 1))
  })
  assert.equal(asked.length, MAX_PAGES - 1)
  assert.equal(errorOf(got), `the command's output could not be read whole: it ran past ${String(MAX_PAGES)} pages`)
})

test('a page step stopped by the usage limit or refused by the harness is passed on as itself, any other failure as unread', async () => {
  const limit = { limit: "You've hit your limit" }
  assert.deepEqual(await readPaged(ran(page(STEP, 0, 9)), async () => limit), { ...limit, run: '/run' })
  const refused = {
    exitCode: 1,
    stdout: '',
    stderr:
      'Permission for this action was denied by the Claude Code auto mode classifier. The command was not run. Denied command: /opt/craft review page (timeout 120000 ms).',
  }
  assert.deepEqual(await readPaged(ran(page(STEP, 0, 9)), async () => refused), { ...refused, run: '/run' })
  // The binary failing the page command says nothing of the step: asked again, then the step is unread, its reason kept.
  let n = 0
  const binary = { exitCode: 1, stdout: '', stderr: 'craft: offset 9 is no character boundary of the 70' }
  const got = await readPaged(ran(page(STEP, 0, 9)), async () => {
    n++
    return binary
  })
  assert.equal(n, 2)
  assert.deepEqual(got, {
    exitCode: 0,
    stderr: '',
    run: '/run',
    cut: 'its page from offset 9 of /run was not read twice: both tries: it exited 1: craft: offset 9 is no character boundary of the 70',
  })
})

test('pages that run past the length the first page named are said cut', async () => {
  const total = STEP.length
  const got = await readPaged(ran(page(STEP, 0, total - 2)), async (_run, from) =>
    ran(`craft-out ${DIR} ${String(total)} ${String(from)} 5\nabcde\ncraft-page ${String(from + 5)}\n`),
  )
  assert.equal(errorOf(got), `the command's output could not be read whole: it came to ${String(total + 3)} of ${String(total)} characters`)
})

test("a page step's two failures are both said: not answered, cut, or the command's capped stderr", async () => {
  let n = 0
  const long = `   craft: ${'x'.repeat(600)}   \n`
  const got = await readPaged(ran(page(STEP, 0, 9)), async () => (n++ === 0 ? null : { exitCode: 1, stdout: '', stderr: long }))
  const said = errorOf(got)
  const capped = long.trim().slice(0, 400)
  assert.equal(
    said,
    `the command's output could not be read whole: its page from offset 9 of /run was not read twice: the first try: it went unanswered; the second: it exited 1: ${capped}`,
  )
  const unanswered = await readPaged(ran(page(STEP, 0, 9)), async () => undefined)
  assert.match(errorOf(unanswered), /was not read twice: both tries: it went unanswered$/)
})

test('a page step that answered no command output is said so', async () => {
  const got = await readPaged(ran(page(STEP, 0, 9)), async () => ({ text: 'done' }))
  assert.match(errorOf(got), /both tries: it answered with no command output$/)
})
