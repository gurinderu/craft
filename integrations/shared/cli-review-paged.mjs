// A binary step read in pages (realm @nick/craft, node #625). The sandbox reads no file, so a service agent copies what
// the command printed into its answer, and a large step — a round of many tasks, a finished run's findings — came back
// cut, read as "the command printed no JSON". With `--paged` the binary writes the step to its run directory and prints
// one bounded page of it, framed — a `craft-out <file> <lines>` line first, a `craft-page <last>` line after the page's
// lines (cli/bin/craft/src/paged.rs); `craft review page` prints the next. A page that comes back without its frame or
// with another count of lines is asked again from the file; the command is never run twice. The step's lines are cut
// where JSON allows whitespace, so they join back with newlines into the same value.
import { absolutePath, isObject } from './cli-review-step.mjs'
import { shq } from './plugin-script.mjs'

/** How many pages the driver reads before it gives the step up as too large. */
export const MAX_PAGES = 64

/** The command that prints the page of `file` from line `from`. @param {string} bin @param {string} file @param {number} from */
export const pageCommand = (bin, file, from) => `${bin} review page --file ${shq(file)} --from ${String(from)}`

/** @typedef {{ file: string, total: number, last: number, lines: string[] }} Page */

/** The file and line count a page's first line names, or null. @param {string} line */
function frameOf(line) {
  const head = /^craft-out (.+) (\d+)$/.exec(line)
  const file = absolutePath(head?.[1])
  return head && file !== null ? { file, total: Number(head[2]) } : null
}

/**
 * A page as the agent copied it, or null when its frame is missing — cut — or its count of lines is not the one its
 * frame names; `from` the line it was asked from.
 * @param {string} stdout @param {number} from @returns {Page | null}
 */
export function pageOf(stdout, from) {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const frame = frameOf(lines[0] ?? '')
  const tail = /^craft-page (\d+)$/.exec(lines.at(-1) ?? '')
  if (!frame || !tail || lines.length < 2) return null
  const last = Number(tail[1])
  const body = lines.slice(1, -1)
  return body.length === last - from + 1 ? { ...frame, last, lines: body } : null
}

/**
 * The step's whole output from a paged command's answer `got`: its first page, then each next one asked through
 * `ask(file, from)`, each asked twice at most. An answer that is not paged — no stdout, a refusal, a binary error, an
 * output not framed — comes back as it is; one whose step could not be read whole comes back with `cut` saying why,
 * and no stdout.
 * @param {unknown} got @param {(file: string, from: number) => Promise<unknown>} ask @returns {Promise<unknown>}
 */
export async function readPaged(got, ask) {
  if (!isObject(got) || typeof got['stdout'] !== 'string' || !got['stdout'].startsWith('craft-out ')) return got
  const { stdout, ...rest } = got
  const read = await linesOf(stdout, ask)
  return 'cut' in read ? { ...rest, cut: read.cut } : { ...rest, stdout: read.lines.join('\n') }
}

/**
 * The step's lines from its first page `stdout` and the pages after it, or why they could not all be read.
 * @param {string} stdout @param {(file: string, from: number) => Promise<unknown>} ask
 * @returns {Promise<{ lines: string[] } | { cut: string }>}
 */
async function linesOf(stdout, ask) {
  const start = firstOf(stdout)
  if (start === null) return { cut: 'its first page named no file' }
  const { file, total } = start
  const lines = start.lines
  let pages = start.pages
  for (let from = start.last + 1; from <= total; pages++) {
    if (pages >= MAX_PAGES) return { cut: `it ran past ${String(MAX_PAGES)} pages` }
    const page = (await pageAt(ask, file, from)) ?? (await pageAt(ask, file, from))
    if (!page) return { cut: `its page from line ${String(from)} of ${file} came back cut twice` }
    lines.push(...page.lines)
    from = page.last + 1
  }
  return { lines }
}

/**
 * The first page read: whole, or, cut, only its first line, which names the file — its lines then read again from
 * line 1; null when not even that came back. @param {string} stdout
 * @returns {{ file: string, total: number, last: number, lines: string[], pages: number } | null}
 */
function firstOf(stdout) {
  const first = pageOf(stdout, 1)
  if (first) return { ...first, lines: [...first.lines], pages: 1 }
  const frame = frameOf(stdout.split('\n')[0] ?? '')
  return frame && { ...frame, last: 0, lines: [], pages: 0 }
}

/**
 * The page from line `from`, or null when it came back cut or empty.
 * @param {(file: string, from: number) => Promise<unknown>} ask @param {string} file @param {number} from
 */
async function pageAt(ask, file, from) {
  const got = await ask(file, from)
  const page = isObject(got) && typeof got['stdout'] === 'string' ? pageOf(got['stdout'], from) : null
  return page && page.last >= from ? page : null
}
