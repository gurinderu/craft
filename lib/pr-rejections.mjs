// The author's rejections of craft findings, read from a PR's review threads, as decision records in
// the memory skill's shape (skills/memory) — what addressing-findings records before it works the
// findings, so the next review can set those findings aside (lib/prior-decisions.mjs). Run by the
// skill as `node <plugin>/lib/pr-rejections.mjs <threads.json>`, over the `gh api graphql` answer
// skills/addressing-findings/pr-rejections.md names. The per-thread rule is lib/pr-thread-rule.mjs.
import fs from 'node:fs'
import { threadDecision, NOT_AUTHORIZED } from './pr-thread-rule.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

/** @typedef {import('./pr-thread-rule.mjs').ReviewThread} ReviewThread @typedef {import('./pr-thread-rule.mjs').DecisionRecord} DecisionRecord */

// The threads read across every page (`gh api graphql --paginate --slurp`): past it, what was not
// read is named, never guessed at.
export const PR_THREADS_MAX = 500

/** One page's threads, its totalCount and the PR author's login, or null. @param {unknown} page */
function pageThreads(page) {
  const pr = /** @type {{ data?: { repository?: { pullRequest?: { author?: { login?: unknown } | null, reviewThreads?: { totalCount?: unknown, nodes?: unknown } } } } }} */ (page)?.data?.repository?.pullRequest
  const threads = pr?.reviewThreads
  if (!pr || !threads || !Array.isArray(threads.nodes)) return null
  return { total: Number(threads.totalCount ?? 0), nodes: /** @type {ReviewThread[]} */ (threads.nodes), author: prAuthorLogin(pr) }
}

/** The PR author's login, '' when the answer does not carry it. @param {{ author?: { login?: unknown } | null }} pr */
function prAuthorLogin(pr) {
  return typeof pr.author?.login === 'string' ? pr.author.login.trim() : ''
}

/**
 * The threads of one answer, or of every page of a slurped (`--paginate --slurp`) array of answers,
 * and the PR author ('' when the answer does not carry it — then only an association can reject).
 * @param {unknown} answer @returns {{ total: number, nodes: ReviewThread[], author: string } | null}
 */
export function reviewThreads(answer) {
  const pages = Array.isArray(answer) ? answer : [answer]
  /** @type {ReviewThread[]} */
  let nodes = []
  let total = 0
  let author = ''
  for (const page of pages) {
    const threads = pageThreads(page)
    if (!threads) return null
    nodes = nodes.concat(threads.nodes)
    total = Math.max(total, threads.total)
    author ||= threads.author
  }
  return pages.length ? { total, nodes, author } : null
}

/**
 * Every rejection in a `gh api graphql` reviewThreads answer.
 * @param {unknown} answer @returns {{ decisions: DecisionRecord[], skipped: string[] } | string}  a string: the input is unreadable
 */
export function rejectionsFromThreads(answer) {
  const threads = reviewThreads(answer)
  if (!threads) return 'not a reviewThreads answer (nor a slurped array of them): data.repository.pullRequest.reviewThreads.nodes is missing'
  /** @type {DecisionRecord[]} */
  const decisions = []
  /** @type {string[]} */
  const skipped = []
  const read = threads.nodes.slice(0, PR_THREADS_MAX)
  for (const t of read) {
    const d = threadDecision(t, threads.author)
    if (typeof d === 'string') skipped.push(d)
    else if (d) decisions.push(d)
  }
  const unauthorized = skipped.filter(s => s.endsWith(NOT_AUTHORIZED)).length
  if (unauthorized) skipped.push(`${unauthorized} rejection(s) not recorded: the replier is neither the PR author nor OWNER/MEMBER/COLLABORATOR`)
  const unread = Math.max(threads.total, threads.nodes.length) - read.length
  if (unread > 0) skipped.push(`${unread} thread(s) past the ${PR_THREADS_MAX} read were not examined — nothing recorded from them`)
  return { decisions, skipped }
}

/**
 * `pr-rejections <threads.json | ->`: the decision records as JSON on stdout.
 * @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv) {
  const o = outputLines()
  const src = argv[0]
  if (!src) { o.stderr.push('usage: pr-rejections <threads.json | -> (the gh api graphql reviewThreads answer)'); return { exitCode: 2, ...o } }
  /** @type {unknown} */
  let answer
  try { answer = JSON.parse(fs.readFileSync(src === '-' ? 0 : src, 'utf8')) } catch (e) {
    o.stderr.push(`pr-rejections: cannot read ${src}: ${e instanceof Error ? e.message : String(e)}`)
    return { exitCode: 2, ...o }
  }
  const r = rejectionsFromThreads(answer)
  if (typeof r === 'string') { o.stderr.push(`pr-rejections: ${r}`); return { exitCode: 2, ...o } }
  o.stdout.push(JSON.stringify(r, null, 2))
  return { exitCode: 0, ...o }
}

await runIfMain(import.meta.url, run)
