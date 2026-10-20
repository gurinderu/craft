// Posting one doubtful finding the reviewer chose (realm @nick/craft, nodes #270, #271): the review engine
// posts only defects and keeps the doubtful ones, numbered, in its run record (`sorting.findings`); for each
// the human picks "ask the author" or "post as a defect", and the launching session runs this script with
// the number. It reads the finding from that record — never from a hand-copied list — and prints the request
// body of one GitHub review comment (REST `POST /repos/{owner}/{repo}/pulls/{pr}/comments`, API version
// 2022-11-28): the body lib/finding-comment.mjs builds, a question carrying its hidden kind line, the
// craft-finding marker last (node #194); anchored to the finding's line (`subject_type: line`, `side:
// RIGHT`), or to its file (`subject_type: file`, no line) when the line is outside the diff, where GitHub
// takes no line comment. For `gh api repos/{owner}/{repo}/pulls/<pr>/comments --input -`. The script
// builds; gh posts: nothing here touches the network, and nothing posts a finding without the marker.
import fs from 'node:fs'
import { findingCommentBody } from './finding-comment.mjs'
import { outputLines, runIfMain } from './script-main.mjs'
import { DEFAULT_STORE, gitIdentity, repoKey } from './craft-log-run.mjs'
import { latestSortedRecord, sortedFindings, sortingOf } from './sorting-choice.mjs'
import { parseJsonObject } from './json-object.mjs'

const USAGE = 'usage: finding-post --as <question|defect> --commit <head sha> [--record <run record>] [--store <dir>] [--project <dir>] <n>'

/** @typedef {import('./sorting-choice.mjs').SortedFinding} SortedFinding */
/** @typedef {{ commit_id: string, path: string, subject_type: 'line', line: number, side: 'RIGHT', body: string } | { commit_id: string, path: string, subject_type: 'file', body: string }} CommentRequest */

/**
 * The review comment request for doubtful finding `n` of `findings` (a run record's `sorting.findings`),
 * posted as `kind` on `commit`; a string: why it cannot be posted. `linesJudged` false (the record's
 * `inDiffJudged`): no line is known to be in the diff, so every comment goes to the file.
 * @param {SortedFinding[]} findings @param {number} n @param {'question' | 'defect'} kind @param {string} commit @param {boolean} [linesJudged]
 * @returns {CommentRequest | string}
 */
export function findingPostRequest(findings, n, kind, commit, linesJudged = true) {
  const f = findings.find(x => Number(x.n) === n)
  if (!f) return `the run record lists no doubtful finding numbered ${n}`
  if (typeof f.file !== 'string' || !f.file.trim()) return `finding ${n} names no file to anchor a review comment to`
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return `--commit must be the PR head sha, got ${JSON.stringify(commit)}`
  const body = findingCommentBody(f, kind)
  const line = Number(f.line)
  if (!linesJudged || f.outsideDiff === true || !Number.isInteger(line) || line <= 0) return { commit_id: commit, path: f.file.trim(), subject_type: 'file', body }
  return { commit_id: commit, path: f.file.trim(), subject_type: 'line', line, side: 'RIGHT', body }
}

/**
 * The `--flag value` options and the operands in order.
 * @param {string[]} argv @returns {{ opt: Record<string, string>, rest: string[] }}
 */
export function splitArgs(argv) {
  /** @type {Record<string, string>} */
  const opt = {}
  /** @type {string[]} */
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (/^--(as|commit|record|store|project)$/.test(a)) opt[a.slice(2)] = String(argv[++i] ?? '')
    else rest.push(a)
  }
  return { opt, rest }
}

/**
 * The options and the number, or why they are unusable.
 * @param {string[]} argv @returns {{ kind: 'question' | 'defect', commit: string, n: number, opt: Record<string, string> } | string}
 */
export function readArgs(argv) {
  const { opt, rest } = splitArgs(argv)
  const kind = opt['as']
  if (kind !== 'question' && kind !== 'defect') return USAGE
  const n = Number(rest[0])
  if (rest.length !== 1 || !Number.isInteger(n) || n < 1) return USAGE
  return { kind, commit: opt['commit'] ?? '', n, opt }
}

/**
 * The run record's doubtful findings: the one `--record` names, else the newest of this project's
 * checkout and branch (lib/sorting-choice.mjs latestSortedRecord), and whether its lines were judged.
 * Throws, naming why, when none.
 * @param {Record<string, string>} opt @param {string} cwd @returns {{ findings: SortedFinding[], linesJudged: boolean }}
 */
export function recordFindings(opt, cwd) {
  const workdir = opt['project'] || cwd
  const file = opt['record'] || latestSortedRecord(opt['store'] || DEFAULT_STORE, repoKey(workdir), gitIdentity(workdir).branch)
  const record = parseJsonObject(fs.readFileSync(file, 'utf8'))
  return { findings: sortedFindings(record), linesJudged: sortingOf(record)?.['inDiffJudged'] !== false }
}

/**
 * `finding-post --as <question|defect> --commit <sha> [--record <f>] <n>`: the request body as JSON on stdout.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} [_env] @param {string} [cwd]
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, cwd = process.cwd()) {
  const o = outputLines()
  const a = readArgs(argv)
  if (typeof a === 'string') { o.stderr.push(a); return { exitCode: 2, ...o } }
  /** @type {{ findings: SortedFinding[], linesJudged: boolean }} */
  let rec
  try { rec = recordFindings(a.opt, cwd) } catch (e) {
    o.stderr.push(`finding-post: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 2, ...o }
  }
  const r = findingPostRequest(rec.findings, a.n, a.kind, a.commit, rec.linesJudged)
  if (typeof r === 'string') { o.stderr.push(`finding-post: ${r}`); return { exitCode: 2, ...o } }
  o.stdout.push(JSON.stringify(r))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
