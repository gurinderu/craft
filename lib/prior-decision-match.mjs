// Which remembered record answers a finding (realm @nick/craft, node #230) — the predicate the
// prior-decision split runs on (lib/prior-decision-apply.mjs). The model rewords a finding's title every
// round, so a title overlap alone missed most records. A record carries the finding's anchor (`line`,
// `lens`); a candidate is a record whose scope holds the finding's file AND whose line is within
// MATCH_LINE_WINDOW of the finding's, or whose lens is the finding's, or whose title shares
// MATCH_CANDIDATE_OVERLAP of the words. File, line and lens together match without a judge; a pair
// with no comparable anchor (an old record, a finding without a line or lens) keeps the title rule
// (decisionAnswers). Every other candidate is disputed: ONE cheap judge per run decides at most
// MATCH_JUDGE_PAIRS_MAX of them; a pair cut by the bound, left unjudged, or put to a dead judge does
// not match, its finding raised normally and the cause named. An overriding passed record (`overrides`,
// realm @nick/craft, node #229) is tried before every other, so its mark wins over its successor's.
// Inlined into src/review.js and src/adversarial-review.js after prior-decisions.mjs.
import { decisionAnswers, inDecisionScope, reraisedBySeverity, titleOverlap } from './prior-decisions.mjs'

// How far apart a record's line and a finding's may be and still anchor one to the other.
export const MATCH_LINE_WINDOW = 15
// The title overlap that makes a record a candidate for the judge (the title rule alone needs 0.6).
export const MATCH_CANDIDATE_OVERLAP = 0.3
// The most disputed pairs one judge sees; the rest are named and do not match.
export const MATCH_JUDGE_PAIRS_MAX = 40
// How much of a judge's why the report keeps, and of a reason or a body the judge is shown.
export const MATCH_WHY_MAX = 200
export const MATCH_BODY_MAX = 800
// How many cut pairs the refusal names.
export const CUT_NAMED_MAX = 10

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 * @typedef {{ d: PriorDecision, how: string }} PriorMatch  the record that answers a finding, and how that was established
 * @typedef {{ f: DecidableFinding, d: PriorDecision }} DisputedPair
 */

export const MATCHED_BY_ANCHOR = 'matched by file:line+lens'
export const MATCHED_BY_TITLE = 'matched by title words'

/** Lower-cased lens names of a value, split on commas. @param {unknown} v @returns {string[]} */
export function lensWords(v) {
  return typeof v === 'string' ? v.toLowerCase().split(/[,;|]/).map(s => s.trim()).filter(Boolean) : []
}

/** The lenses a finding names: its `lens`, each of its `sources`, its `source`. @param {DecidableFinding} f @returns {Set<string>} */
export function findingLenses(f) {
  const sources = Array.isArray(f['sources']) ? /** @type {unknown[]} */ (f['sources']) : []
  return new Set([f['lens'], ...sources, f['source']].flatMap(lensWords))
}

/** A finding's line when it is a positive integer, else 0. @param {DecidableFinding} f @returns {number} */
export function findingLine(f) {
  const n = Number(f['line'])
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * How record `d` stands to finding `f`: `anchored` (file, line within the window, lens), `title` (no
 * comparable anchor, the title rule holds), `disputed` (a candidate for the judge), '' (none).
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {'anchored' | 'title' | 'disputed' | ''}
 */
export function matchClass(f, d) {
  if (!inDecisionScope(f.file, d.scope)) return ''
  const { near, same, comparable } = anchorOf(f, d)
  if (!comparable) return decisionAnswers(f, d) ? 'title' : ''
  if (near && same) return 'anchored'
  return near || same || titleOverlap(f.title, d.title) >= MATCH_CANDIDATE_OVERLAP ? 'disputed' : ''
}

/**
 * How the record's anchor meets the finding's: line within the window, a shared lens, and whether either
 * side could be compared at all. @param {DecidableFinding} f @param {PriorDecision} d
 * @returns {{ near: boolean, same: boolean, comparable: boolean }}
 */
export function anchorOf(f, d) {
  const line = findingLine(f)
  const own = lensWords(d.lens)
  const lenses = findingLenses(f)
  const byLine = !!d.line && line > 0
  const byLens = own.length > 0 && lenses.size > 0
  return {
    near: byLine && Math.abs(line - Number(d.line)) <= MATCH_LINE_WINDOW,
    same: byLens && own.some(l => lenses.has(l)),
    comparable: byLine || byLens,
  }
}

/** The records in the order they are tried: those overriding another first. @param {PriorDecision[]} ds @returns {PriorDecision[]} */
export function triedOrder(ds) {
  const first = ds.filter(d => d.overrides?.length)
  return first.length ? [...first, ...ds.filter(d => !d.overrides?.length)] : ds
}

/**
 * One finding against the records in tried order: the first sure match, and the disputed candidates
 * tried before it (the judge decides whether one of them answers it first).
 * @param {DecidableFinding} f @param {PriorDecision[]} ordered @returns {{ sure?: PriorMatch, disputed: PriorDecision[] }}
 */
export function findingPlan(f, ordered) {
  /** @type {PriorDecision[]} */
  const disputed = []
  for (const d of ordered) {
    const c = matchClass(f, d)
    if (c === 'anchored' || c === 'title') return { sure: { d, how: c === 'anchored' ? MATCHED_BY_ANCHOR : MATCHED_BY_TITLE }, disputed }
    if (c === 'disputed') disputed.push(d)
  }
  return { disputed }
}

/** The answer each finding gets without a judge: its first sure match. @param {PriorDecision[]} ds @returns {(f: DecidableFinding) => PriorMatch | undefined} */
export function sureMatchOf(ds) {
  const ordered = triedOrder(ds)
  return f => findingPlan(f, ordered).sure
}

/** One line of model or record text, cut at `max`. @param {unknown} v @param {number} [max] */
export function clipLine(v, max = MATCH_WHY_MAX) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// What the judge returns: one verdict per pair.
export const MATCH_JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array', description: 'one entry per pair',
      items: {
        type: 'object', additionalProperties: false, required: ['pair', 'same', 'why'],
        properties: {
          pair: { type: 'integer', description: 'the PAIR number' },
          same: { type: 'boolean', description: 'true only when the record and the finding are about the same defect' },
          why: { type: 'string', description: 'one line: what makes them the same or different' },
        },
      },
    },
  },
}

/** One pair as the judge reads it. @param {DisputedPair} p @param {number} i @returns {string} */
export function judgePair(p, i) {
  const { d, f } = p
  const lenses = [...findingLenses(f)].join(', ')
  return `--- PAIR ${i} ---
RECORD (${d.kind} ${d.id}, from an earlier round): ${clipLine(d.title)}
  scope ${d.scope}${d.line ? `, line ${d.line}` : ''}${d.lens ? `, lens ${clipLine(d.lens)}` : ''}
  reason: ${clipLine(d.reason, MATCH_BODY_MAX)}
FINDING (this round): ${clipLine(f.title)}
  ${clipLine(f.file)}:${findingLine(f)}${lenses ? `, lens ${clipLine(lenses)}` : ''}
  body: ${clipLine(f['why'] ?? f['description'], MATCH_BODY_MAX)}`
}

/** The judge's prompt. @param {DisputedPair[]} pairs @returns {string} */
export function judgePrompt(pairs) {
  return `Decide, for each pair below, whether a remembered record (a decision or a deferred question on a review finding) and a finding of this review round are about the SAME defect. The reviewer rewords every finding each round, so judge the substance, not the words: the same missing guard, unchecked case or wrong behaviour at the same site is the same defect in new wording, even a few lines off; a different defect near the same code, or the same kind of defect at another site, is not. Judge from the text given; read nothing else and change nothing.
${pairs.map(judgePair).join('\n')}
Return {verdicts: [one {pair, same, why} per pair]}: pair is the PAIR number, same is true only when they are the same defect, why is one line naming what makes them the same or different.`
}

/**
 * One verdict as the judge returned it, or null when it is off-shape or its pair is outside 0..n-1.
 * @param {unknown} v @param {number} n @returns {{ i: number, same: boolean, why: string } | null}
 */
export function judgeVerdict(v, n) {
  const o = /** @type {Record<string, unknown>} */ (v && typeof v === 'object' ? v : {})
  const i = o['pair']
  const same = o['same']
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= n || typeof same !== 'boolean') return null
  return { i, same, why: clipLine(o['why']) || 'no reason given' }
}

/**
 * The judge's verdicts by pair index, or null when the answer is absent or carries no verdict list.
 * A verdict off-shape, out of range or repeating a pair is ignored. @param {unknown} raw @param {number} n
 * @returns {Map<number, { same: boolean, why: string }> | null}
 */
export function readJudge(raw, n) {
  const list = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw)['verdicts'] : null
  if (!Array.isArray(list)) return null
  /** @type {Map<number, { same: boolean, why: string }>} */
  const out = new Map()
  for (const v of list) {
    const r = judgeVerdict(v, n)
    if (r && !out.has(r.i)) out.set(r.i, { same: r.same, why: r.why })
  }
  return out
}

/** The refusal naming the pairs past the bound. @param {DisputedPair[]} cut @returns {string} */
export function cutPairsNote(cut) {
  const named = cut.slice(0, CUT_NAMED_MAX).map(p => `"${clipLine(p.f.title, 60)}" @ ${clipLine(p.f.file)}:${findingLine(p.f)} ~ ${p.d.id}`)
  const more = cut.length - named.length
  return `${cut.length} disputed record–finding pair(s) past the judge's bound of ${MATCH_JUDGE_PAIRS_MAX} were not judged — not matched, their findings raised normally: ${named.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * Runs the judge over `sent` (never empty): the verdicts by pair index; a missing judge, a throw or an
 * unreadable answer yields none, said once in `refused`. @param {DisputedPair[]} sent
 * @param {((prompt: string) => Promise<unknown>) | undefined} judge @param {string[]} refused
 * @returns {Promise<Map<number, { same: boolean, why: string }>>}
 */
export async function askJudge(sent, judge, refused) {
  /** @type {unknown} */
  let raw = null
  try { raw = judge ? await judge(judgePrompt(sent)) : null } catch { raw = null }
  const v = readJudge(raw, sent.length)
  if (!v) {
    refused.push(`the match judge died or answered unreadably — ${sent.length} disputed record–finding pair(s) not matched, their findings raised normally`)
    return new Map()
  }
  const unjudged = sent.length - v.size
  if (unjudged) refused.push(`the match judge returned no verdict for ${unjudged} disputed record–finding pair(s) — not matched, their findings raised normally`)
  return v
}

/**
 * Matches every finding to the record that answers it: a sure match, unless a disputed candidate tried
 * before it is judged the same. `judge` runs once, only when a disputed pair exists; the pairs of
 * findings a record can set aside (below Critical/High) go first under the bound.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions
 * @param {((prompt: string) => Promise<unknown>) | undefined} judge
 * @returns {Promise<{ matchOf: (f: DecidableFinding) => PriorMatch | undefined, notes: string[], refused: string[] }>}
 */
export async function matchFindings(findings, decisions, judge) {
  const ordered = triedOrder(decisions)
  const plans = new Map(findings.map(f => [f, findingPlan(f, ordered)]))
  const all = [...plans].flatMap(([f, p]) => p.disputed.map(d => ({ f, d })))
  const pairs = [...all.filter(p => !reraisedBySeverity(p.f.severity)), ...all.filter(p => reraisedBySeverity(p.f.severity))]
  /** @type {string[]} */
  const notes = []
  /** @type {string[]} */
  const refused = []
  const sent = pairs.slice(0, MATCH_JUDGE_PAIRS_MAX)
  if (pairs.length > sent.length) refused.push(cutPairsNote(pairs.slice(sent.length)))
  const verdicts = sent.length ? await askJudge(sent, judge, refused) : new Map()
  /** @type {Map<DecidableFinding, Map<PriorDecision, { same: boolean, why: string }>>} */
  const byFinding = new Map()
  sent.forEach((p, i) => {
    const v = verdicts.get(i)
    if (v) byFinding.set(p.f, (byFinding.get(p.f) ?? new Map()).set(p.d, v))
  })
  if (sent.length && verdicts.size) notes.push(`match judge: ${verdicts.size} disputed pair(s) judged, ${[...verdicts.values()].filter(v => v.same).length} the same`)
  /** @param {DecidableFinding} f @returns {PriorMatch | undefined} */
  const matchOf = f => {
    const p = plans.get(f)
    const judged = byFinding.get(f)
    const d = judged && p?.disputed.find(x => judged.get(x)?.same)
    return d && judged ? { d, how: `matched by judge: ${judged.get(d)?.why}` } : p?.sure
  }
  return { matchOf, notes, refused }
}
