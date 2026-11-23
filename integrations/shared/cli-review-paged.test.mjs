// A paged step read whole (integrations/shared/cli-review-paged.mjs): its pages joined, a cut page asked again from the
// file, never the command; and the review driver reading a paged submit through `craft review page`.
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PAGES, pageOf, readPaged } from './cli-review-paged.mjs'
import { commandOutput } from './cli-review-step.mjs'
import { runEngine } from './engine-harness.mjs'

const FILE = '/run/host-step.out'

/** A page as the binary prints it. @param {string[]} lines @param {number} total @param {number} from */
const framed = (lines, total, from) => `craft-out ${FILE} ${String(total)}\n${lines.map(l => `${l}\n`).join('')}craft-page ${String(from + lines.length - 1)}\n`
/** A service answer carrying `stdout`. @param {string} stdout */
const ran = stdout => ({ exitCode: 0, stdout, stderr: '' })

const LINES = ['{"run":"/run",', '"done":false,', '"tasks":[]}']

test('a page is read only with its frame and the count of lines it names', () => {
  assert.deepEqual(pageOf(framed(LINES.slice(1), 3, 2), 2), { file: FILE, total: 3, last: 3, lines: LINES.slice(1) })
  assert.equal(pageOf(framed(LINES, 3, 1).replace(/craft-page 3\n$/, ''), 1), null, 'cut before its last line')
  assert.equal(pageOf(framed(LINES, 3, 1).replace('"done":false,\n', ''), 1), null, 'a line dropped inside')
  assert.equal(pageOf(framed(LINES, 3, 1).replace(FILE, 'host-step.out'), 1), null, 'a file that is no absolute path')
})

test('an answer that is not paged comes back as it is', async () => {
  const asked = []
  for (const got of [ran('{"run":"/r"}'), { exitCode: 1, stdout: '', stderr: 'craft: no run' }, null, { limit: 'x' }]) {
    assert.equal(await readPaged(got, async () => asked.push(1)), got)
  }
  assert.equal(asked.length, 0)
})

test('the pages join into the step, each asked from the line after the last', async () => {
  /** @type {number[]} */
  const asked = []
  const got = await readPaged({ ...ran(framed(LINES.slice(0, 1), 3, 1)), exitCode: 0 }, async (file, from) => {
    asked.push(from)
    assert.equal(file, FILE)
    return ran(framed(LINES.slice(from - 1, from), 3, from))
  })
  assert.deepEqual(asked, [2, 3])
  assert.deepEqual(JSON.parse(String(commandOutput(got).stdout)), { run: '/run', done: false, tasks: [] })
})

test('a page cut once is asked again; cut twice, the step is said cut, never parsed', async () => {
  let n = 0
  const once = await readPaged(ran(framed(LINES.slice(0, 2), 3, 1)), async () =>
    n++ === 0 ? ran('craft-out /run/host-step.out 3\n"tas') : ran(framed(LINES.slice(2), 3, 3)),
  )
  assert.equal(n, 2)
  assert.deepEqual(JSON.parse(String(commandOutput(once).stdout)), { run: '/run', done: false, tasks: [] })
  const twice = await readPaged(ran(framed(LINES.slice(0, 2), 3, 1)), async () => ran('craft-out /run/host-step.out 3\n'))
  assert.deepEqual(commandOutput(twice), { error: `the command's output could not be read whole: its page from line 3 of ${FILE} came back cut twice` })
})

test('a first page cut is read again from the file it names', async () => {
  /** @type {number[]} */
  const asked = []
  const got = await readPaged(ran(`craft-out ${FILE} 3\n{"run":"/ru`), async (_file, from) => {
    asked.push(from)
    return ran(framed(LINES.slice(from - 1), 3, from))
  })
  assert.deepEqual(asked, [1])
  assert.deepEqual(JSON.parse(String(commandOutput(got).stdout)), { run: '/run', done: false, tasks: [] })
})

test('a step past the page bound is given up, not read for ever', async () => {
  const total = MAX_PAGES + 5
  let n = 0
  const got = await readPaged(ran(framed(['{'], total, 1)), async (_file, from) => {
    n++
    return ran(framed([`"k${String(from)}":1,`], total, from))
  })
  assert.equal(n, MAX_PAGES - 1)
  assert.deepEqual(commandOutput(got), { error: `the command's output could not be read whole: it ran past ${String(MAX_PAGES)} pages` })
})

let RUN = ''
beforeEach(() => {
  RUN = mkdtempSync(join(tmpdir(), 'craft-run-'))
})
afterEach(() => {
  rmSync(RUN, { recursive: true, force: true })
})

test('the driver reads a paged submit through `craft review page` and goes on with the step', async () => {
  const file = `${RUN}/host-step.out`
  const done = [`{"run":"${RUN}",`, '"done":true,', `"report":"${RUN}/report.md",`, '"verdict":"Block"}']
  const page = (/** @type {number} */ from, /** @type {number} */ to) =>
    ran(`craft-out ${file} 4\n${done.slice(from - 1, to).join('\n')}\ncraft-page ${String(to)}\n`)
  const run = await runEngine('review', {
    args: { craftBin: '/opt/craft', craftRoot: '/plugin' },
    script: {
      'step:root': ran('root=/plugin\n'),
      'step:start': ran(
        JSON.stringify({
          run: RUN,
          done: false,
          tasks: [{ id: 'l', label: 'lens:a', model: 'opus', promptFile: `${RUN}/p.md`, schemaFile: `${RUN}/s.json`, answerFile: `${RUN}/a.json` }],
        }),
      ),
      lens: 'done',
      'step:submit:1': page(1, 2),
      'step:submit:1:page': page(3, 4),
    },
  })
  const pageCall = run.calls.find(c => c.label === 'step:submit:1:page')
  assert.match(String(pageCall?.prompt), new RegExp(`^/opt/craft review page --file '${file}' --from 3$`, 'm'))
  assert.match(run.report, /^## Verdict\n\n⛔ Block/)
})
