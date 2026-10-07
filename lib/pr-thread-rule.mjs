// The rule that decides whether one PR review thread is the author rejecting a craft finding, and
// the decision record it yields (the memory skill's shape, skills/memory). Conservative: the first
// comment must be a craft finding (lib/finding-comment.mjs) and the last word must reject it. Read
// across a whole PR by lib/pr-rejections.mjs.
import crypto from 'node:crypto'
import { readFindingComment } from './finding-comment.mjs'

// One page of comments per thread (`comments(first: 50)`): past it, the last word is unknown and the
// thread is named, never guessed at.
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
/** @param {unknown} v */
const str = v => String(v ?? '').trim()

/**
 * A thread with no reply rejects its finding only when someone other than the poster resolved it
 * and the code at the finding is unchanged (the thread is not outdated).
 * @param {ReviewThread} t @param {ThreadComment} root @returns {{ by: string, reason: string, url: string } | string}
 */
export function silentResolution(t, root) {
  const resolver = login(t.resolvedBy)
  const unchanged = t.isResolved === true && t.isOutdated === false
  if (!unchanged || !resolver || resolver === login(root.author)) return 'no reply, and not resolved by someone else with the code unchanged'
  return { by: resolver, reason: `Resolved by ${resolver} without a reply or a change to the code at the finding.`, url: str(root.url) }
}

/**
 * The rejection a thread carries: who, the reason, the comment's URL — or why there is none.
 * @param {ReviewThread} t @param {ThreadComment[]} cs @returns {{ by: string, reason: string, url: string } | string}
 */
export function threadRejection(t, cs) {
  const root = /** @type {ThreadComment} */ (cs[0])
  const last = /** @type {ThreadComment} */ (cs[cs.length - 1])
  if (cs.length === 1) return silentResolution(t, root)
  if (login(last.author) === login(root.author)) return 'the last word is the finding poster\'s'
  const text = str(last.body)
  if (!REJECTION.test(text)) return 'the last reply does not open with a rejection'
  return { by: login(last.author), reason: text, url: str(last.url) }
}

/**
 * What stops a rejection from becoming a record: no anchor, or a field past its ceiling. '' when none.
 * @param {string} title @param {string} scope @param {string} commit @param {string} reason @returns {string}
 */
export function recordProblem(title, scope, commit, reason) {
  if (!scope || !/^[0-9a-f]{7,40}$/i.test(commit)) return 'no path or commit to anchor the decision to'
  if (title.length > REJECTION_TITLE_MAX) return `title over ${REJECTION_TITLE_MAX} chars: record it by hand`
  if (reason.length > REJECTION_REASON_MAX) return `reason is ${reason.length} chars, over ${REJECTION_REASON_MAX}: summarise it and record by hand`
  return ''
}

/**
 * A thread whose first comment is a craft finding, read: its comments, the finding, the path, and
 * how many comments it has in all. null for any other thread.
 * @param {ReviewThread} t
 */
export function craftThread(t) {
  const cs = Array.isArray(t.comments?.nodes) ? t.comments.nodes : []
  const root = cs[0]
  const finding = root ? readFindingComment(root.body) : null
  if (!root || !finding) return null
  return { cs, root, finding, scope: str(t.path), total: Number(t.comments?.totalCount ?? cs.length) }
}

/**
 * One thread as a decision record, or why it is not one (null: not a craft finding at all).
 * @param {ReviewThread} t @returns {DecisionRecord | string | null}
 */
export function threadDecision(t) {
  const c = craftThread(t)
  if (!c) return null
  const where = `${c.scope || '?'}: ${c.finding.title}`
  if (c.total > c.cs.length) return `${where} — ${c.total} comments, past the ${THREAD_COMMENTS_MAX} read: the last word is unknown`
  const r = threadRejection(t, c.cs)
  if (typeof r === 'string') return `${where} — ${r}`
  const commit = str(c.root.originalCommit?.oid)
  const problem = recordProblem(c.finding.title, c.scope, commit, r.reason)
  if (problem) return `${where} — ${problem}`
  return {
    id: decisionId(c.finding.title, c.scope), kind: 'decision', title: c.finding.title, body: r.reason, scope: c.scope, status: 'active',
    date: str(c.cs[c.cs.length - 1]?.createdAt).slice(0, 10), author: r.by, commit, links: [r.url, str(c.root.url)].filter(Boolean),
  }
}

