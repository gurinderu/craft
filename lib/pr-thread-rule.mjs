// The rule that decides whether one PR review thread is the author rejecting a craft finding, and
// the decision record it yields (the memory skill's shape, skills/memory; realm @nick/craft, node #177). Conservative: the first
// comment must be a craft finding (lib/finding-comment.mjs) posted by an account GitHub associates
// with the repository as OWNER, MEMBER or COLLABORATOR (craft posts under the account of the human
// running it, who maintains the repo — anyone else can paste the marker), and the last word must be a reply that
// rejects it, from the PR author or a replier GitHub associates with the repository as OWNER, MEMBER
// or COLLABORATOR. No reply is no rejection: a thread resolved silently may have been fixed outside
// the hunk (realm @nick/craft, node #185). Read across a whole PR by lib/pr-rejections.mjs.
import { readFindingComment } from './finding-comment.mjs'
import { memoryRecordId } from './memory-record-id.mjs'

// One page of comments per thread (`comments(first: 50)`): past it, the last word is unknown and the
// thread is named, never guessed at.
export const THREAD_COMMENTS_MAX = 50
// The memory record's bounds: a longer title or reason is refused, to be recorded by hand.
export const REJECTION_TITLE_MAX = 200
export const REJECTION_REASON_MAX = 1200

// A reply rejects the finding only when it OPENS with one of these — "this is not a bug in X, but…"
// mid-sentence does not count, nor does any reply that is not the thread's last word.
const REJECTION = /^(?:(?:this|it|that)(?: is|'s) )?(not a bug|not an issue|by design|won'?t fix|wontfix|will not fix|works as intended|working as intended|as intended|intentional|false positive)\b/i

// Who may reject: the PR author, or one of these associations (realm @nick/craft, node #182 — a
// drive-by commenter's "not a bug" must not silence a finding for the whole project).
export const REJECTING_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']
// The tail of the skip line for a rejection from anyone else; lib/pr-rejections.mjs counts by it.
export const NOT_AUTHORIZED = 'who is neither the PR author nor an owner, member or collaborator: not recorded'
// The tail of the skip line for a marked root comment from an account with no such association: a
// forged finding — the PR author is no authority here, they could post the marker themselves.
export const NOT_CRAFT_ROOT = 'who is not an owner, member or collaborator: not a craft finding, not recorded'

/**
 * @typedef {{ author?: { login?: unknown } | null, authorAssociation?: unknown, body?: unknown, url?: unknown, createdAt?: unknown, originalCommit?: { oid?: unknown } | null }} ThreadComment
 * @typedef {{ path?: unknown, line?: unknown, originalLine?: unknown, comments?: { totalCount?: unknown, nodes?: ThreadComment[] } }} ReviewThread
 * @typedef {{ id: string, kind: 'decision', title: string, body: string, scope: string, status: 'active', date: string, author: string, commit: string, links: string[], line?: number, lens?: string, ruleId?: string }} DecisionRecord
 */

/** The memory skill's id: `decision-` + 10 hex of sha256(kind, title, scope). @param {string} title @param {string} scope */
export function decisionId(title, scope) {
  return memoryRecordId('decision', title, scope)
}

/** @param {{ login?: unknown } | null | undefined} a */
const login = a => String(a?.login ?? '').trim()
/** @param {unknown} v */
const str = v => String(v ?? '').trim()

/**
 * The rejection a thread carries: who, the reason, the comment's URL — or why there is none.
 * @param {ThreadComment[]} cs @param {string} prAuthor @returns {{ by: string, reason: string, url: string } | string}
 */
export function threadRejection(cs, prAuthor) {
  const last = /** @type {ThreadComment} */ (cs[cs.length - 1])
  if (cs.length === 1) return 'no reply — only an explicit rejection reply counts'
  const text = str(last.body)
  if (!REJECTION.test(text)) return 'the last reply does not open with a rejection'
  const by = login(last.author)
  const assoc = str(last.authorAssociation).toUpperCase()
  if (!(by && by === prAuthor) && !REJECTING_ASSOCIATIONS.includes(assoc)) return `rejected by ${by || '?'} (association ${assoc || 'unknown'}), ${NOT_AUTHORIZED}`
  return { by, reason: text, url: str(last.url) }
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
 * Why a marked root comment is not craft's (realm @nick/craft, node #186): its author has no OWNER/MEMBER/COLLABORATOR association.
 * '' when it is. @param {ThreadComment} root @returns {string}
 */
function forgedRoot(root) {
  const assoc = str(root.authorAssociation).toUpperCase()
  if (REJECTING_ASSOCIATIONS.includes(assoc)) return ''
  return `the finding comment was posted by ${login(root.author) || '?'} (association ${assoc || 'unknown'}), ${NOT_CRAFT_ROOT}`
}

/**
 * The finding's anchor a thread carries (realm @nick/craft, node #230): `line` — the thread's line on the
 * commit it was posted on (`originalLine`, else `line`), when a positive integer; `lens` — from the
 * finding comment's lens line; `ruleId` — from its rule line (realm @nick/craft, node #236). Each
 * present only when available.
 * @param {ReviewThread} t @param {{ lens?: string, ruleId?: string }} finding @returns {{ line?: number, lens?: string, ruleId?: string }}
 */
export function threadAnchor(t, finding) {
  const line = [t.originalLine, t.line].find(v => typeof v === 'number' && Number.isInteger(v) && v > 0)
  return { ...(typeof line === 'number' ? { line } : {}), ...(finding.lens ? { lens: finding.lens } : {}), ...(finding.ruleId ? { ruleId: finding.ruleId } : {}) }
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
 * @param {ReviewThread} t @param {string} [prAuthor]  the PR author's login, '' when unknown
 * @returns {DecisionRecord | string | null}
 */
export function threadDecision(t, prAuthor = '') {
  const c = craftThread(t)
  if (!c) return null
  const where = `${c.scope || '?'}: ${c.finding.title}`
  const forged = forgedRoot(c.root)
  if (forged) return `${where} — ${forged}`
  if (c.total > c.cs.length) return `${where} — ${c.total} comments, past the ${THREAD_COMMENTS_MAX} read: the last word is unknown`
  const r = threadRejection(c.cs, prAuthor)
  if (typeof r === 'string') return `${where} — ${r}`
  const commit = str(c.root.originalCommit?.oid)
  const problem = recordProblem(c.finding.title, c.scope, commit, r.reason)
  if (problem) return `${where} — ${problem}`
  return {
    id: decisionId(c.finding.title, c.scope), kind: 'decision', title: c.finding.title, body: r.reason, scope: c.scope, status: 'active',
    date: str(c.cs[c.cs.length - 1]?.createdAt).slice(0, 10), author: r.by, commit, links: [r.url, str(c.root.url)].filter(Boolean),
    ...threadAnchor(t, c.finding),
  }
}

