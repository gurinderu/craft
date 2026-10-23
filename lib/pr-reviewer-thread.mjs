// A rejection in the thread of a reviewer that is not craft (realm @nick/craft, node #302): a person or
// their own tool comments on the PR, the comment carries no craft-finding marker, and the last word is a
// reply that rejects it, from the PR author or an OWNER/MEMBER/COLLABORATOR — the same reply rule as a
// craft thread (lib/pr-thread-rule.mjs, nodes #182, #197). It becomes a decision record without asking
// (node #223), so the same remark in the next PR is set aside by triage's sift (node #305). The root may
// come from anyone; one guard more than a craft thread needs: an outsider who rejects their own remark
// has settled nothing, or a contributor could post a remark and its rejection to silence a finding for
// the whole project (the reason a forged craft root is refused, node #186). No reply is no rejection
// (node #185). Read across a whole PR by lib/pr-rejections.mjs, after lib/pr-thread-rule.mjs says the
// thread is not craft's.
import { REJECTING_ASSOCIATIONS, THREAD_COMMENTS_MAX, decisionId, recordProblem, threadAnchor, threadRejection } from './pr-thread-rule.mjs'

/**
 * @typedef {import('./pr-thread-rule.mjs').ReviewThread} ReviewThread
 * @typedef {import('./pr-thread-rule.mjs').DecisionRecord} DecisionRecord
 */

// A reviewer's remark has no title line of its own: its first line, cut at a word, stands in for one.
export const REMARK_TITLE_MAX = 120

// The tail of the skip line for an outsider rejecting their own remark; lib/pr-rejections.mjs counts by it.
export const SELF_DISMISSED = 'who also wrote the remark and is not an owner, member or collaborator: not recorded'

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
 * One thread whose root is not a craft finding, as a decision record, or why its rejection is not
 * recorded; null when the thread holds no rejection at all (most remarks: fixed, answered, open).
 * @param {ReviewThread} t @param {string} [prAuthor]  the PR author's login, '' when unknown
 * @returns {DecisionRecord | string | null}
 */
export function reviewerThreadDecision(t, prAuthor = '') {
  const cs = Array.isArray(t.comments?.nodes) ? t.comments.nodes : []
  const root = cs[0]
  if (!root || cs.length < 2) return null
  const total = Number(t.comments?.totalCount ?? cs.length)
  const title = remarkTitle(root.body)
  const scope = str(t.path)
  const where = `${scope || '?'}: ${title || '(remark without text)'} (reviewer ${str(root.author?.login) || '?'})`
  if (total > cs.length) return `${where} — ${total} comments, past the ${THREAD_COMMENTS_MAX} read: the last word is unknown`
  const r = threadRejection(cs, prAuthor)
  if (typeof r === 'string') return r.startsWith('rejected by') ? `${where} — ${r}` : null
  const rootBy = str(root.author?.login)
  const assoc = str(cs[cs.length - 1]?.authorAssociation).toUpperCase()
  if (rootBy && rootBy === r.by && !REJECTING_ASSOCIATIONS.includes(assoc)) return `${where} — rejected by ${r.by}, ${SELF_DISMISSED}`
  if (!title) return `${where} — the remark has no text to title the decision: record it by hand`
  const commit = str(root.originalCommit?.oid)
  const problem = recordProblem(title, scope, commit, r.reason)
  if (problem) return `${where} — ${problem}`
  return {
    id: decisionId(title, scope), kind: 'decision', title, body: r.reason, scope, status: 'active',
    date: str(cs[cs.length - 1]?.createdAt).slice(0, 10), author: r.by, commit, links: [r.url, str(root.url)].filter(Boolean),
    ...threadAnchor(t, {}),
  }
}
