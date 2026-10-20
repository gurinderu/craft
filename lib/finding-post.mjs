// Posting one doubtful finding the reviewer chose (realm @nick/craft, nodes #270, #271): the review engine
// posts only defects and lists the doubtful ones with their data; for each the human picks "ask the author"
// or "post as a defect", and the launching session runs this script on that list. It prints the request
// body of one GitHub review comment — the finding's file and line, and the body lib/finding-comment.mjs
// builds, a question carrying its hidden kind line, the craft-finding marker last (node #194) — for
// `gh api repos/{owner}/{repo}/pulls/<pr>/comments --input -`. The script builds; gh posts: nothing here
// touches the network, and nothing posts a finding without the marker.
import fs from 'node:fs'
import { findingCommentBody } from './finding-comment.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

const USAGE = 'usage: finding-post --as <question|defect> --commit <head sha> <doubtful.json | -> <n>'

/** @typedef {{ n?: unknown, severity?: unknown, title?: unknown, file?: unknown, line?: unknown, why?: unknown, fix?: unknown, source?: unknown, toolRule?: unknown }} Postable */

/**
 * The review comment request for finding `n` of `list` (the report's JSON line, or one finding), posted as
 * `kind` on `commit`; a string: why it cannot be posted.
 * @param {unknown} list @param {number} n @param {'question' | 'defect'} kind @param {string} commit
 * @returns {{ commit_id: string, path: string, line: number, side: 'RIGHT', body: string } | string}
 */
export function findingPostRequest(list, n, kind, commit) {
  const all = /** @type {Postable[]} */ (Array.isArray(list) ? list : [list])
  const f = all.find(x => x && typeof x === 'object' && Number(x.n) === n)
  if (!f) return `no finding numbered ${n} in the list`
  const line = Number(f.line)
  if (typeof f.file !== 'string' || !f.file.trim() || !Number.isInteger(line) || line <= 0) return `finding ${n} has no file:line to anchor a review comment to`
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return `--commit must be the PR head sha, got ${JSON.stringify(commit)}`
  return { commit_id: commit, path: f.file.trim(), line, side: 'RIGHT', body: findingCommentBody(f, kind) }
}

/**
 * The options and operands of the command line, or why they are unusable.
 * @param {string[]} argv @returns {{ kind: 'question' | 'defect', commit: string, src: string, n: number } | string}
 */
export function readArgs(argv) {
  const { opt, rest } = splitArgs(argv)
  const kind = opt['as']
  if (kind !== 'question' && kind !== 'defect') return USAGE
  const n = Number(rest[1])
  if (rest.length !== 2 || !Number.isInteger(n) || n < 1) return USAGE
  return { kind, commit: opt['commit'] ?? '', src: String(rest[0]), n }
}

/**
 * The `--as` and `--commit` values, and the operands in order.
 * @param {string[]} argv @returns {{ opt: Record<string, string>, rest: string[] }}
 */
export function splitArgs(argv) {
  /** @type {Record<string, string>} */
  const opt = {}
  /** @type {string[]} */
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--as' || a === '--commit') opt[a.slice(2)] = String(argv[++i] ?? '')
    else rest.push(a)
  }
  return { opt, rest }
}

/**
 * `finding-post --as <question|defect> --commit <sha> <doubtful.json | -> <n>`: the request body as JSON on stdout.
 * @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv) {
  const o = outputLines()
  const a = readArgs(argv)
  if (typeof a === 'string') { o.stderr.push(a); return { exitCode: 2, ...o } }
  /** @type {unknown} */
  let list
  try { list = JSON.parse(fs.readFileSync(a.src === '-' ? 0 : a.src, 'utf8')) } catch (e) {
    o.stderr.push(`finding-post: cannot read ${a.src}: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 2, ...o }
  }
  const r = findingPostRequest(list, a.n, a.kind, a.commit)
  if (typeof r === 'string') { o.stderr.push(`finding-post: ${r}`); return { exitCode: 2, ...o } }
  o.stdout.push(JSON.stringify(r))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
