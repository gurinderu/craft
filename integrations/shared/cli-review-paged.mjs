// A binary step read in pages (realm @nick/craft, node #625). The sandbox reads no file, so a service agent copies what
// the command printed into its answer, and a large step — a round of many tasks, a finished run's findings — came back
// cut, read as "the command printed no JSON". With `--paged` the binary writes the step to its run directory and prints
// one bounded page of it (cli/bin/craft/src/paged.rs): a `craft-out <run> <total> <from> <count>` line naming the run
// directory, the page's `count` characters of the step from offset `from` on one line, and a `craft-page <end>` line —
// offsets and counts in UTF-16 code units, as a string's length counts them. `craft review page --run <run>` prints the
// next. The pages are joined with no separator. Every count is checked, and every page must name the first page's run
// and total, so a page cut in a copy is asked again, two different steps are never joined, and the command is never
// run twice. A page step that fails says nothing of the step itself: whatever it exits with, the step was not read
// whole — only the usage limit and the harness's refusal stop the run as themselves.
import { absolutePath, isObject } from './cli-review-step.mjs'
import { harnessRefusal } from './cli-review-refusal.mjs'
import { shq } from './plugin-script.mjs'

/** How many pages the driver reads before it gives the step up as too large. */
export const MAX_PAGES = 64

/** The command that prints the page of the run in `run`'s step from offset `from`. @param {string} bin @param {string} run @param {number} from */
export const pageCommand = (bin, run, from) => `${bin} review page --run ${shq(run)} --from ${String(from)}`

/** @typedef {{ run: string, total: number }} Frame  the step a page belongs to: its run directory and its length */
/** @typedef {Frame & { from: number, body: string, end: number }} Page */
/**
 * @typedef {Record<string, unknown> & { cut?: string, run: string }} Unread  a paged answer whose step was not read: the
 *   first answer with `cut` saying why and no stdout, or the usage limit's or the harness's stop; `run` the run
 *   directory the first page named, which exists though its step was not read
 */

/** The frame a page's first line names, with where the page starts and how long it is, or null. @param {string} line */
function headOf(line) {
  const head = /^craft-out (.+) (\d+) (\d+) (\d+)$/.exec(line)
  const run = absolutePath(head?.[1])
  return head && run !== null ? { run, total: Number(head[2]), from: Number(head[3]), count: Number(head[4]) } : null
}

/**
 * A page as the agent copied it, or null when it is not the page from offset `from` whole: its frame missing — cut — or
 * a count that does not hold.
 * @param {string} stdout @param {number} from @returns {Page | null}
 */
export function pageOf(stdout, from) {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== 3) return null
  const [first = '', body = '', last = ''] = lines
  const head = headOf(first)
  // The closing line holds the offset the page started at: a page of another offset fails it.
  if (!head || body.length !== head.count) return null
  const end = from + head.count
  return last === `craft-page ${String(end)}` ? { run: head.run, total: head.total, from, body, end } : null
}

/**
 * The step's whole output from a paged command's answer `got`: its first page, then each next one asked through
 * `ask(run, from)`, each asked twice at most. An answer that is not paged — no stdout, a refusal, a binary error, an
 * output not framed — comes back as it is; one whose step was not read comes back as an Unread.
 * @param {unknown} got @param {(run: string, from: number) => Promise<unknown>} ask @returns {Promise<unknown>}
 */
export async function readPaged(got, ask) {
  if (!isObject(got) || typeof got['stdout'] !== 'string' || !got['stdout'].startsWith('craft-out ')) return got
  const { stdout, ...rest } = got
  const frame = pageOf(stdout, 0) ?? headOf(stdout.split('\n')[0] ?? '')
  // A first page cut keeps its first line, which names the run; one that names none is no step of a run.
  if (frame === null) return { ...rest, cut: 'its first page named no run directory' }
  const read = await stepOf(stdout, frame, ask)
  if ('text' in read) return { ...rest, stdout: read.text }
  /** @type {Unread} */
  const unread = 'stop' in read ? { ...read.stop, run: frame.run } : { ...rest, cut: read.cut, run: frame.run }
  return unread
}

/** The run directory of a paged answer whose step was not read, null for any other answer. @param {unknown} got */
export const unreadRun = got => (isObject(got) && typeof got['run'] === 'string' ? got['run'] : null)

/**
 * The step's text from its first page `stdout` and the pages after it, why it could not all be read, or the answer that
 * stopped a page step.
 * @param {string} stdout @param {Frame} frame @param {(run: string, from: number) => Promise<unknown>} ask
 * @returns {Promise<{ text: string } | { cut: string } | { stop: Record<string, unknown> }>}
 */
async function stepOf(stdout, frame, ask) {
  const first = pageOf(stdout, 0)
  let text = first ? first.body : ''
  for (let pages = first ? 1 : 0; text.length < frame.total; pages++) {
    if (pages >= MAX_PAGES) return { cut: `it ran past ${String(MAX_PAGES)} pages` }
    const page = await twice(ask, frame, text.length)
    if (!('body' in page)) return page
    text += page.body
  }
  return text.length === frame.total ? { text } : { cut: `it came to ${String(text.length)} of ${String(frame.total)} characters` }
}

/**
 * The page of `frame`'s step from offset `from`, asked once more when it was not read; the answer that stopped it, or
 * why it could not be read, the page command's own failure quoted.
 * @param {(run: string, from: number) => Promise<unknown>} ask @param {Frame} frame @param {number} from
 * @returns {Promise<Page | { cut: string } | { stop: Record<string, unknown> }>}
 */
async function twice(ask, frame, from) {
  /** @type {string[]} */
  const whys = []
  for (let tries = 0; tries < 2; tries++) {
    const got = await ask(frame.run, from)
    if (isObject(got) && (typeof got['limit'] === 'string' || harnessRefusal(got) !== null)) return { stop: got }
    const page = pageIn(got, frame, from)
    if (page) return page
    whys.push(whyUnread(got))
  }
  const [first = '', last = ''] = whys
  const said = first === last ? `both ${first}` : `first ${first}, then ${last}`
  return { cut: `its page from offset ${String(from)} of ${frame.run} was not read twice: ${said}` }
}

/** The page of `frame`'s step from `from` that `got` carries, null when it carries none. @param {unknown} got @param {Frame} frame @param {number} from */
function pageIn(got, frame, from) {
  const page = isObject(got) && typeof got['stdout'] === 'string' ? pageOf(got['stdout'], from) : null
  return page && ofStep(page, frame) ? page : null
}

/**
 * Why a page step's answer is no page: its service agent returned nothing, its command ran and failed (its exit and
 * stderr), or what it copied came back cut. @param {unknown} got @returns {string}
 */
function whyUnread(got) {
  if (got == null) return 'went unanswered'
  if (!isObject(got) || typeof got['exitCode'] !== 'number' || got['exitCode'] === 0) return 'came back cut'
  const stderr = String(got['stderr'] ?? '')
    .trim()
    .slice(0, 400)
  return `exited ${String(got['exitCode'])}${stderr ? `: ${stderr}` : ''}`
}

/**
 * Whether `page` is one of `frame`'s step that moves on: another step's page — its run or length not the first page's —
 * or one that moves nothing is not. @param {Page} page @param {Frame} frame
 */
const ofStep = (page, frame) => page.run === frame.run && page.total === frame.total && page.end > page.from
