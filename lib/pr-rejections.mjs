// The author's rejections of craft findings, read from a PR's review threads, as decision records in
// the memory skill's shape (skills/memory) — what addressing-findings records before it works the
// findings, so the next review can set those findings aside (lib/prior-decisions.mjs). Run by the
// skill as `node <plugin>/lib/pr-rejections.mjs <threads.json>`, over the `gh api graphql` answer
// skills/addressing-findings/SKILL.md names. Conservative by construction: a thread counts only when
// its first comment is a craft finding (lib/finding-comment.mjs) and its last word rejects it.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { readFindingComment } from './finding-comment.mjs'
import { outputLines, runIfMain } from './script-main.mjs'

// One GraphQL page each (`reviewThreads(first: 100)`, `comments(first: 50)`): past either, what was
// not read is named, never guessed at.
export const PR_THREADS_MAX = 100
export const THREAD_COMMENTS_MAX = 50
// The memory record's bounds: a longer title or reason is refused, to be recorded by hand.
export const REJECTION_TITLE_MAX = 200
export const REJECTION_REASON_MAX = 1200

// A reply rejects the finding only when it OPENS with one of these — "this is not a bug in X, but…"
// mid-sentence does not count, nor does any reply that is not the thread's last word.
const REJECTION = /^(?:(?:this|it|that)(?: is|'s) )?(not a bug|not an issue|by design|won'?t fix|wontfix|will not fix|works as intended|working as intended|as intended|intentional|false positive)\b/i

/**
 * @typedef {{ author?: { login?: unknown } | null, body?: unknown, url?: unknown, createdAt?: unknown, originalCommit?: { oid?: unknown } | null }} ThreadComment
 * @typedef {{ isResolved?: unknown, isOutdated?: unknown, path?: unknown, resolvedBy?: { login?: unknown } | null, comments?: { totalCount?: unknown, nodes?: ThreadComment[] } }} ReviewThread
 * @typedef {{ id: string, kind: 'decision', title: string, body: string, scope: string, status: 'active', date: string, author: string, commit: string, links: string[] }} DecisionRecord
 */

/** The memory skill's id: `decision-` + 10 hex of sha256(kind, title, scope). @param {string} title @param {string} scope */
export function decisionId(title, scope) {
  const t = title.trim().replace(/\s+/g, ' ').toLowerCase()
  const s = scope.replace(/^\.\//, '').replace(/\/+$/, '')
  return `decision-${crypto.createHash('sha256').update(`decision\n${t}\n${s}`).digest('hex').slice(0, 10)}`
}

/** @param {{ login?: unknown } | null | undefined} a */
const login = a => String(a?.login ?? '').trim()

/**
 * The rejection a thread carries: its rejecting comment and the reason, or why there is none.
 * @param {ReviewThread} t @param {ThreadComment[]} cs @returns {{ by: string, reason: string, url: string } | string}
 */
export function threadRejection(t, cs) {
  const root = /** @type {ThreadComment} */ (cs[0])
  const last = /** @type {ThreadComment} */ (cs[cs.length - 1])
  const poster = login(root.author)
  if (cs.length === 1) {
    const resolver = login(t.resolvedBy)
    if (t.isResolved !== true || t.isOutdated !== false || !resolver || resolver === poster) return 'no reply, and not resolved by someone else with the code unchanged'
    return { by: resolver, reason: `Resolved by ${resolver} without a reply or a change to the code at the finding.`, url: String(root.url ?? '') }
  }
  const text = String(last.body ?? '').trim()
  if (login(last.author) === poster) return 'the last word is the finding poster\'s'
  if (!REJECTION.test(text)) return 'the last reply does not open with a rejection'
  return { by: login(last.author), reason: text, url: String(last.url ?? '') }
}

/**
 * One thread as a decision record, or why it is not one (null: not a craft finding at all).
 * @param {ReviewThread} t @returns {DecisionRecord | string | null}
 */
export function threadDecision(t) {
  const cs = Array.isArray(t.comments?.nodes) ? t.comments.nodes : []
  const finding = cs.length ? readFindingComment(cs[0]?.body) : null
  if (!finding) return null
  const where = `${String(t.path ?? '?')}: ${finding.title}`
  if (Number(t.comments?.totalCount ?? cs.length) > cs.length) return `${where} — ${String(t.comments?.totalCount)} comments, past the ${THREAD_COMMENTS_MAX} read: the last word is unknown`
  const r = threadRejection(t, cs)
  if (typeof r === 'string') return `${where} — ${r}`
  const scope = String(t.path ?? '').trim()
  const commit = String(cs[0]?.originalCommit?.oid ?? '')
  if (!scope || !/^[0-9a-f]{7,40}$/i.test(commit)) return `${where} — no path or commit to anchor the decision to`
  if (finding.title.length > REJECTION_TITLE_MAX) return `${where} — title over ${REJECTION_TITLE_MAX} chars: record it by hand`
  if (r.reason.length > REJECTION_REASON_MAX) return `${where} — reason is ${r.reason.length} chars, over ${REJECTION_REASON_MAX}: summarise it and record by hand`
  return {
    id: decisionId(finding.title, scope), kind: 'decision', title: finding.title, body: r.reason, scope, status: 'active',
    date: String(cs[cs.length - 1]?.createdAt ?? '').slice(0, 10), author: r.by, commit, links: [r.url, String(cs[0]?.url ?? '')].filter(Boolean),
  }
}

/**
 * Every rejection in a `gh api graphql` reviewThreads answer.
 * @param {unknown} answer @returns {{ decisions: DecisionRecord[], skipped: string[] } | string}  a string: the input is unreadable
 */
export function rejectionsFromThreads(answer) {
  const threads = /** @type {{ data?: { repository?: { pullRequest?: { reviewThreads?: { totalCount?: unknown, nodes?: unknown } } } } }} */ (answer)?.data?.repository?.pullRequest?.reviewThreads
  if (!threads || !Array.isArray(threads.nodes)) return 'not a reviewThreads answer: data.repository.pullRequest.reviewThreads.nodes is missing'
  const nodes = /** @type {ReviewThread[]} */ (threads.nodes)
  /** @type {DecisionRecord[]} */
  const decisions = []
  /** @type {string[]} */
  const skipped = []
  for (const t of nodes.slice(0, PR_THREADS_MAX)) {
    const d = threadDecision(t)
    if (typeof d === 'string') skipped.push(d)
    else if (d) decisions.push(d)
  }
  const unread = Math.max(Number(threads.totalCount ?? 0), nodes.length) - Math.min(nodes.length, PR_THREADS_MAX)
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
