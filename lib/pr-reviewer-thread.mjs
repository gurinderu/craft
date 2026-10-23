// A rejection in the thread of a reviewer that is not craft (realm @nick/craft, node #302): a person or
// their own tool comments on the PR, the comment carries no craft-finding marker, and the last word is a
// reply that rejects it, from an OWNER/MEMBER/COLLABORATOR. It becomes a decision record without asking
// (node #223), so the same remark in the next PR is set aside by triage's sift (node #305). The root may
// come from anyone, so the reply rule is narrower than a craft thread's (lib/pr-thread-rule.mjs, nodes
// #182, #197): there the PR author's word counts, here only a maintainer's. Logins prove nothing — an
// outside PR author with a second account could post a remark under one and reject it under the other,
// silencing a finding for the whole project (the reason a forged craft root is refused, node #186) — so
// a PR author without that association never settles another reviewer's remark. No reply is no
// rejection (node #185). Read across a whole PR by lib/pr-rejections.mjs, after lib/pr-thread-rule.mjs
// says the thread is not craft's.
import { REJECTING_ASSOCIATIONS, THREAD_COMMENTS_MAX, decisionId, recordProblem, threadAnchor, threadRejection } from './pr-thread-rule.mjs'

/**
 * @typedef {import('./pr-thread-rule.mjs').ReviewThread} ReviewThread
 * @typedef {import('./pr-thread-rule.mjs').DecisionRecord} DecisionRecord
 */

// A reviewer's remark has no title line of its own: its first line, cut at a word, stands in for one.
export const REMARK_TITLE_MAX = 120

// The tail of the skip line for a PR author with no maintainer association rejecting another reviewer's
// remark; lib/pr-rejections.mjs counts by it.
export const NOT_A_MAINTAINER = "the PR author but not an owner, member or collaborator: another reviewer's remark is not theirs to settle, not recorded"

/** @param {unknown} v */
const str = v => String(v ?? '').trim()

/**
 * The title a remark stands under: its first line with any heading, quote or emphasis marks around it
 * dropped, cut at a word past REMARK_TITLE_MAX; '' when it has no line of text.
 * @param {unknown} body @returns {string}
 */
export function remarkTitle(body) {
  const first = String(body ?? '').split('\n').map(l => l.replace(/^[\s#>*_-]+|[\s*_]+$/g, '').replace(/\s+/g, ' ')).find(Boolean) ?? ''
  if (first.length <= REMARK_TITLE_MAX) return first
  const cut = first.slice(0, REMARK_TITLE_MAX)
  const at = cut.lastIndexOf(' ')
  return `${(at > REMARK_TITLE_MAX / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/**
 * A thread whose root is not a craft finding, read: its comments, the root, the remark's title, the
 * path, its reviewer, how many comments it has in all, and how a skip line names it. null with no reply.
 * @param {ReviewThread} t
 */
export function remarkThread(t) {
  const cs = Array.isArray(t.comments?.nodes) ? t.comments.nodes : []
  const root = cs[0]
  if (!root || cs.length < 2) return null
  const title = remarkTitle(root.body)
  const scope = str(t.path)
  const reviewer = str(root.author?.login)
  return { cs, root, title, scope, reviewer, total: Number(t.comments?.totalCount ?? cs.length), where: remarkName(scope, title, reviewer) }
}

/** How a skip line names a remark. @param {string} scope @param {string} title @param {string} reviewer */
const remarkName = (scope, title, reviewer) => `${scope || '?'}: ${title || '(remark without text)'} (reviewer ${reviewer || '?'})`

/**
 * Why a rejection cannot settle the remark, '' when it can: a rejecter who is not an owner, member or
 * collaborator (the PR author, whose word counts in a craft thread only), or a remark with no text to
 * title the decision.
 * @param {NonNullable<ReturnType<typeof remarkThread>>} c @param {string} by @returns {string}
 */
function unsettled(c, by) {
  const assoc = str(c.cs[c.cs.length - 1]?.authorAssociation).toUpperCase()
  if (!REJECTING_ASSOCIATIONS.includes(assoc)) return `rejected by ${by || '?'} (association ${assoc || 'unknown'}), ${NOT_A_MAINTAINER}`
  return c.title ? '' : 'the remark has no text to title the decision: record it by hand'
}

/**
 * One thread whose root is not a craft finding, as a decision record, or why its rejection is not
 * recorded; null when the thread holds no rejection at all (most remarks: fixed, answered, open).
 * @param {ReviewThread} t @param {string} [prAuthor]  the PR author's login, '' when unknown
 * @returns {DecisionRecord | string | null}
 */
export function reviewerThreadDecision(t, prAuthor = '') {
  const c = remarkThread(t)
  if (!c) return null
  if (c.total > c.cs.length) return `${c.where} — ${c.total} comments, past the ${THREAD_COMMENTS_MAX} read: the last word is unknown`
  const r = threadRejection(c.cs, prAuthor)
  if (typeof r === 'string') return r.startsWith('rejected by') ? `${c.where} — ${r}` : null
  const commit = str(c.root.originalCommit?.oid)
  const problem = unsettled(c, r.by) || recordProblem(c.title, c.scope, commit, r.reason)
  if (problem) return `${c.where} — ${problem}`
  return {
    id: decisionId(c.title, c.scope), kind: 'decision', title: c.title, body: r.reason, scope: c.scope, status: 'active',
    date: str(c.cs[c.cs.length - 1]?.createdAt).slice(0, 10), author: r.by, commit, links: [r.url, str(c.root.url)].filter(Boolean),
    ...threadAnchor(t, {}),
  }
}
