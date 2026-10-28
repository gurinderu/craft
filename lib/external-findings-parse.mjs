// An external reviewer's findings on a PR, read from what GitHub returns for it: the inline review comments
// (`gh api repos/<repo>/pulls/<n>/comments --paginate --slurp`, flattened) and the PR's reviews
// (`gh pr view <n> --json reviews,headRefName,commits,author`). The measurement this serves — craft's recall
// against an external reviewer on the same branch — is realm @nick/craft, node #378; matching is done by
// lib/match-external-findings.mjs.
import { createHash } from 'node:crypto'

/** @typedef {{ id: number, user: { login: string }, body: string, path?: string | null, line?: number | null, original_line?: number | null, original_commit_id?: string, created_at: string, html_url?: string, in_reply_to_id?: number | null }} PrComment */
/** @typedef {{ author: { login: string }, body: string, submittedAt: string, commit?: { oid: string } | null }} PrReview */
/** @typedef {{ author?: { login: string } | null, headRefName: string, commits: Array<{ oid: string }>, reviews: PrReview[] }} PrView */
/** @typedef {{ status: string, sha: string, at: string }} Reply */
/** @typedef {{ at: string, head: string | null }} Round */
/** @typedef {{ id: string, path: string | null, line: number | null, sev: string | null, body: string, ctx: string, url: string | null, rootId: number | null, round: Round }} Raw */
/** @typedef {Raw & { rounds: number }} Finding */
/** @typedef {{ reviewers: string[], idRe: RegExp | null, exRe: RegExp | null, sevRe: RegExp }} ParseOptions */

// CI and service accounts are never "the reviewer" by default.
const BOT = /\b(ci|github-actions|dependabot|codecov|sonar)\b|\[bot\]$/i
export const DEFAULT_SEVERITY = /\b(must-fix|should-fix|optional)\b/i
// The reviewer's own follow-up on a thread: "Fixed at `abc1234`", "Still present at `…`".
const REPLY = /^(Fixed|Still present|Risk accepted|Not reproduced|Superseded)[^`]*`([0-9a-f]{7,40})`/i
// A review submitted within this long before the comment's creation still counts as its round.
const ROUND_SLACK_MS = 120_000
/** @type {Record<string, string>} */
const BARE_SEVERITY = { must: 'must-fix', should: 'should-fix', optional: 'optional' }

/** Everyone who commented or reviewed, except the PR author and CI bots. @param {PrView} pr @param {PrComment[]} comments */
export function defaultReviewers(pr, comments) {
  const logins = [...comments.map(c => c.user.login), ...pr.reviews.map(r => r.author.login)]
  return [...new Set(logins)].filter(l => l !== pr.author?.login && !BOT.test(l))
}

/** Root comment id → the reviewer's status replies on that thread. @param {PrComment[]} comments @param {string[]} reviewers */
export function statusReplies(comments, reviewers) {
  /** @type {Map<number, Reply[]>} */
  const out = new Map()
  for (const c of comments) {
    const m = c.in_reply_to_id && reviewers.includes(c.user.login) ? REPLY.exec(c.body) : null
    if (!m?.[1] || !m[2] || !c.in_reply_to_id) continue
    out.set(c.in_reply_to_id, [...(out.get(c.in_reply_to_id) ?? []), { status: m[1].toLowerCase(), sha: m[2], at: c.created_at }])
  }
  return out
}

/** @param {string} text @param {RegExp} sevRe @returns {string | null} */
const severityIn = (text, sevRe) => sevRe.exec(text)?.[1]?.toLowerCase() ?? null

/** A review-body heading's severity: the severity words, else a bare must/should/optional. @param {string} heading @param {RegExp} sevRe */
const headingSeverity = (heading, sevRe) => severityIn(heading, sevRe) ?? BARE_SEVERITY[/must|should|optional/i.exec(heading)?.[0]?.toLowerCase() ?? ''] ?? null

/** The reviewer's earliest review on the comment's commit, submitted at or after it: the round's time. @param {PrComment} c @param {PrReview[]} mine */
function roundOf(c, mine) {
  const at = Date.parse(c.created_at) - ROUND_SLACK_MS
  const rv = mine.filter(r => r.commit?.oid === c.original_commit_id && Date.parse(r.submittedAt) >= at)
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0]
  return { at: rv?.submittedAt ?? c.created_at, head: c.original_commit_id ?? null }
}

/** A `- **…**` bullet of a review body that carries an id, as a finding. @param {string} l @param {string} heading @param {PrReview} r @param {ParseOptions & { idRe: RegExp }} o @returns {Raw | null} */
function bulletFinding(l, heading, r, o) {
  const id = /^\s*[-*]\s+\*\*(.+?)\*\*/.test(l) ? o.idRe.exec(l)?.[0] : undefined
  if (!id) return null
  const loc = /`([^`:]+\.[a-z]+):(\d+)/i.exec(l)
  return { id, path: loc?.[1] ?? null, line: loc ? Number(loc[2]) : null, sev: headingSeverity(heading, o.sevRe), body: l,
    ctx: `${heading} ${l.slice(0, 120)}`, url: null, rootId: null, round: { at: r.submittedAt, head: r.commit?.oid ?? null } }
}

/** Findings listed only in review bodies, under their `##`–`####` headings. @param {PrReview[]} mine @param {ParseOptions & { idRe: RegExp }} o */
function bodyFindings(mine, o) {
  /** @type {Raw[]} */
  const out = []
  for (const r of mine) {
    let heading = ''
    for (const l of r.body.split('\n')) {
      const h = /^#{2,4}\s+(.*)/.exec(l)
      if (h) heading = h[1] ?? ''
      const f = h ? null : bulletFinding(l, heading, r, o)
      if (f) out.push(f)
    }
  }
  return out
}

/** A root comment as a finding; null when `idRe` finds no id in it. @param {PrComment} c @param {ParseOptions} o @param {PrReview[]} mine @returns {Raw | null} */
function inlineFinding(c, o, mine) {
  const first = c.body.split('\n')[0] ?? ''
  const path = c.path ?? null
  const line = c.line ?? c.original_line ?? null
  const id = o.idRe ? o.idRe.exec(c.body)?.[0] : createHash('sha1').update(`${path}|${line}|${first}`).digest('hex').slice(0, 8)
  if (!id) return null
  return { id, path, line, sev: severityIn(c.body, o.sevRe), body: c.body, ctx: first, url: c.html_url ?? null, rootId: c.id, round: roundOf(c, mine) }
}

/** One per id, at its earliest round. @param {Map<string, Finding>} found @param {Raw} f */
function keep(found, f) {
  const have = found.get(f.id)
  if (!have) { found.set(f.id, { ...f, rounds: 1 }); return }
  have.rounds++
  if (Date.parse(f.round.at) < Date.parse(have.round.at)) have.round = f.round
}

/**
 * The reviewer's findings on one PR, one per id, each at its earliest round. With `idRe`, a root comment that
 * carries no id is a status note (`unanchored`), and review bodies add findings that have no inline anchor;
 * without it, a finding's id is a hash of its path, line and first line. `exRe` drops a finding by its first
 * line, and every other comment under the same id with it.
 * @param {PrView} pr @param {PrComment[]} comments @param {ParseOptions} o
 * @returns {{ findings: Finding[], excluded: number, unanchored: number }}
 */
export function parseFindings(pr, comments, o) {
  const mine = pr.reviews.filter(r => o.reviewers.includes(r.author.login) && r.body)
  const roots = comments.filter(c => !c.in_reply_to_id && o.reviewers.includes(c.user.login))
  const inline = roots.map(c => inlineFinding(c, o, mine))
  const raws = inline.filter(f => f !== null)
  const unanchored = inline.length - raws.length
  const { idRe } = o
  if (idRe) raws.push(...bodyFindings(mine, { ...o, idRe }).filter(f => !raws.some(x => x.id === f.id)))
  const dropped = new Set(raws.filter(f => o.exRe?.test(f.ctx)).map(f => f.id))
  /** @type {Map<string, Finding>} */
  const found = new Map()
  for (const f of raws) if (!dropped.has(f.id)) keep(found, f)
  return { findings: [...found.values()], excluded: dropped.size, unanchored }
}
