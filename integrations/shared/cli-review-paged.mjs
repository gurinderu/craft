// A binary step read in pages (realm @nick/craft, node #625). The sandbox reads no file, so a service agent copies what
// the command printed into its answer, and a large step — a round of many tasks, a finished run's findings — came back
// cut, read as "the command printed no JSON". With `--paged` the binary writes the step to its run directory and prints
// one bounded page of it (cli/bin/craft/src/paged.rs): a `craft-out <file> <total> <from> <count>` line, the page's
// `count` characters of the step from offset `from` on one line, and a `craft-page <end>` line — offsets and counts in
// UTF-16 code units, as a string's length counts them. `craft review page` prints the next. The pages are joined with
// no separator. Every count is checked, and every page must name the first page's file and total, so a page cut in a
// copy is asked again from the file, two different steps are never joined, and the command is never run twice.
import { absolutePath, isObject } from './cli-review-step.mjs'
import { harnessRefusal } from './cli-review-refusal.mjs'
import { shq } from './plugin-script.mjs'

/** How many pages the driver reads before it gives the step up as too large. */
export const MAX_PAGES = 64

/** The command that prints the page of `file` from offset `from`. @param {string} bin @param {string} file @param {number} from */
export const pageCommand = (bin, file, from) => `${bin} review page --file ${shq(file)} --from ${String(from)}`

/** @typedef {{ file: string, total: number }} Frame  the step a page belongs to: its file and its length */
/** @typedef {Frame & { from: number, body: string, end: number }} Page */

/** The frame a page's first line names, with where the page starts and how long it is, or null. @param {string} line */
function headOf(line) {
  const head = /^craft-out (.+) (\d+) (\d+) (\d+)$/.exec(line)
  const file = absolutePath(head?.[1])
  return head && file !== null ? { file, total: Number(head[2]), from: Number(head[3]), count: Number(head[4]) } : null
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
  return last === `craft-page ${String(end)}` ? { file: head.file, total: head.total, from, body, end } : null
}

/**
 * The step's whole output from a paged command's answer `got`: its first page, then each next one asked through
 * `ask(file, from)`, each asked twice at most. An answer that is not paged — no stdout, a refusal, a binary error, an
 * output not framed — comes back as it is. A page step the usage limit stopped, the harness refused or the binary
 * refused comes back as that answer, with `pagedRun`; one whose step could not be read whole comes back with `cut`
 * saying why, no stdout, and `pagedRun`: the run directory the step was written to, which exists though its step was
 * not read.
 * @param {unknown} got @param {(file: string, from: number) => Promise<unknown>} ask @returns {Promise<unknown>}
 */
export async function readPaged(got, ask) {
  if (!isObject(got) || typeof got['stdout'] !== 'string' || !got['stdout'].startsWith('craft-out ')) return got
  const { stdout, ...rest } = got
  const read = await stepOf(stdout, ask)
  if ('text' in read) return { ...rest, stdout: read.text }
  const run = runOf(stdout)
  const pagedRun = run === null ? {} : { pagedRun: run }
  return 'stop' in read ? { ...(isObject(read.stop) ? read.stop : {}), ...pagedRun } : { ...rest, cut: read.cut, ...pagedRun }
}

/** The run directory a paged answer's first line names its step file in, null when it names none. @param {string} stdout */
function runOf(stdout) {
  const file = headOf(stdout.split('\n')[0] ?? '')?.file
  if (file === undefined) return null
  const at = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return at > 0 ? file.slice(0, at) : null
}

/** The run directory a paged answer named, when its step could not be read. @param {unknown} got @returns {string | null} */
export const pagedRunOf = got => (isObject(got) && typeof got['pagedRun'] === 'string' ? got['pagedRun'] : null)

/**
 * The step's text from its first page `stdout` and the pages after it, why it could not all be read, or the answer that
 * stopped a page step.
 * @param {string} stdout @param {(file: string, from: number) => Promise<unknown>} ask
 * @returns {Promise<{ text: string } | { cut: string } | { stop: unknown }>}
 */
async function stepOf(stdout, ask) {
  const first = pageOf(stdout, 0)
  // A first page cut keeps its first line, which names the step.
  const frame = first ?? headOf(stdout.split('\n')[0] ?? '')
  if (frame === null) return { cut: 'its first page named no file' }
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
 * The page of `frame`'s step from offset `from`, asked once more when it came back cut; the answer that stopped it, or
 * why it could not be read.
 * @param {(file: string, from: number) => Promise<unknown>} ask @param {Frame} frame @param {number} from
 * @returns {Promise<Page | { cut: string } | { stop: unknown }>}
 */
async function twice(ask, frame, from) {
  for (let tries = 0; tries < 2; tries++) {
    const got = await ask(frame.file, from)
    if (pageStopped(got)) return { stop: got }
    const page = isObject(got) && typeof got['stdout'] === 'string' ? pageOf(got['stdout'], from) : null
    if (page && ofStep(page, frame)) return page
  }
  return { cut: `its page from offset ${String(from)} of ${frame.file} came back cut twice` }
}

/**
 * Whether a page step's answer is no page to ask again: the usage limit's stop, the harness's refusal, or the binary's —
 * the command ran and failed, its reason on stderr. @param {unknown} got
 */
const pageStopped = got =>
  isObject(got) && (typeof got['limit'] === 'string' || harnessRefusal(got) !== null || (typeof got['exitCode'] === 'number' && got['exitCode'] !== 0))

/**
 * Whether `page` is one of `frame`'s step that moves on: another step's page — its file or length not the first page's —
 * or one that moves nothing is not. @param {Page} page @param {Frame} frame
 */
const ofStep = (page, frame) => page.file === frame.file && page.total === frame.total && page.end > page.from
