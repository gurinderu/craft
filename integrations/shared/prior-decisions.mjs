// Prior decisions on findings, handed to the review engine by the session that launched it: the
// project's recorded rejections ("not a bug here, because …"), recalled from whatever memory the
// project keeps (the `memory` skill) for the paths of the diff. The engine never drops a finding a
// decision answers — it sets it aside under its own section, marked with who rejected it, when, why
// and where. A finding is raised again normally when it is Critical, when it is High and no human's
// decision (`decidedBy: "human"`) answers it (realm @nick/craft, node #196), when the code in the
// decision's scope changed since the commit the decision was recorded at, or when that cannot be
// established. The engine recalls them itself on every launch and a passed list adds to that recall
// (integrations/shared/memory-recall.mjs; realm @nick/craft, node #218); a malformed one applies nothing and is named.
// This module reads the argument and matches; one decision is read by integrations/shared/prior-decision-record.mjs,
// scopes are checked by integrations/shared/prior-decision-scope.mjs and findings split by integrations/shared/prior-decision-apply.mjs.
// Imported by integrations/claude-code/src/rust-audit.js and integrations/claude-code/src/triage-findings.js.
import { DECISION_FIELD_MAX, decisionScopeParts, hasControlChar, readPriorDecision, recordId, recordKind } from './prior-decision-record.mjs'
import { keptRecords } from './memory-bounds.mjs'

// The most decisions one run applies — across the recalled and the passed records together (realm
// @nick/craft, node #218); the rest are refused by name and their findings raised normally. Project
// rules are counted apart, under a cap of the same size (node #273): a rule is a stance on a whole class
// of findings and a project holds few, so the decisions a long-lived project piles up on its paths must
// not push them off the end of the list. Past the cap the decisions closest to the reviewed paths are
// kept (keptRecords), never simply the first in the list.
export const PRIOR_DECISIONS_MAX = 100
// What the refusal of the records past the cap says about how they were chosen and how to apply them:
// by the reviewed paths when the caller gave them, else by the records' own scopes alone (keptRecords).
const CUT_HOW =
  'kept are the records closest to the reviewed paths (a scope naming a changed file, then a directory holding one, a deeper scope before a shallower, a newer record before an older); to apply the rest, review a narrower path (path=<dir>) or supersede the records that no longer hold'
const CUT_HOW_PATHLESS =
  'no reviewed paths are given here, so kept are the records with a scope before those over the whole repository, a deeper scope before a shallower, a newer record before an older; to apply the rest, review a narrower path (path=<dir>) or supersede the records that no longer hold'
// A decision answers a finding when the finding's file sits inside the decision's scope AND their
// titles share at least this share of words (of the longer one) (realm @nick/craft, node #187).
export const DECISION_TITLE_OVERLAP = 0.6

/**
 * @typedef {import('./prior-decision-record.mjs').PriorDecision} PriorDecision
 * @typedef {{ file?: unknown, title?: unknown, severity?: unknown, why?: unknown, tier?: unknown, [k: string]: unknown }} DecidableFinding
 */

/** A refusal's label for the record at index `i`. @param {number} i @returns {string} */
export const decisionLabel = i => `decision #${i}`

/** The record's id (its own, else the derived one) when it is fit to print, else ''. @param {unknown} item @returns {string} */
export function printableId(item) {
  const id = item && typeof item === 'object' && !Array.isArray(item) ? recordId(/** @type {Record<string, unknown>} */ (item)) : ''
  return id && id.length <= DECISION_FIELD_MAX.id && !hasControlChar(id) ? id : ''
}

/**
 * The records past the cap, each named (its label and id), the names bounded by the cap itself.
 * @param {unknown[]} list @param {number[]} cut the indices past the cap @param {(i: number) => string} labelOf @returns {string}
 */
export function cutNames(list, cut, labelOf) {
  const named = cut.slice(0, PRIOR_DECISIONS_MAX).map(i => {
    const id = printableId(list[i])
    return `${labelOf(i)}${id ? ` (${id})` : ''}`
  })
  const more = cut.length - named.length
  return `${named.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * The `priorDecisions` argument (or a recall's answer merged with it), checked. Absent → nothing of it applied, no refusal
 * (the engine's own recall still runs: integrations/shared/memory-recall.mjs). Anything else that is not a list → nothing applied, each problem named.
 * @param {unknown} raw @param {(i: number) => string} [labelOf] how a refusal names the record at index i
 * @param {string[]} [paths] the reviewed paths the cap ranks the records by
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
export function parsePriorDecisions(raw, labelOf = decisionLabel, paths = []) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  // Only a list inside an object argument: in the key=value form a value cannot be delimited, and a
  // JSON string invites that form, so any string is refused (integrations/shared/workflow-args.mjs OBJECT_ONLY_OPTIONS; realm @nick/craft, node #183).
  if (typeof raw === 'string')
    return {
      decisions: [],
      refused: [
        'priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied',
      ],
    }
  const list = raw
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  const { read, cut, cutRules } = underCaps(list, paths)
  read.forEach(i => {
    const d = readPriorDecision(list[i], labelOf(i))
    if (typeof d === 'string') refused.push(d)
    // The scope check answers by id: two decisions under one id could lend one's unchanged scope to
    // the other, so the second is refused.
    else if (decisions.some(x => x.id === d.id)) refused.push(`${labelOf(i)} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (cut.length)
    refused.push(
      `${cut.length} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — ${paths.length ? CUT_HOW : CUT_HOW_PATHLESS}; findings they would answer are raised normally: ${cutNames(list, cut, labelOf)}`,
    )
  if (cutRules.length)
    refused.push(
      `${cutRules.length} project rule(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would cover are raised normally: ${cutNames(list, cutRules, labelOf)}`,
    )
  return { decisions, refused }
}

/**
 * The indices of `list` read, in its order, and those past the caps: the project rules counted apart
 * from the other records, each under PRIOR_DECISIONS_MAX; past it the decisions closest to the reviewed
 * `paths` are kept (keptRecords), the rules in the order given.
 * @param {unknown[]} list @param {string[]} paths
 * @returns {{ read: number[], cut: number[], cutRules: number[] }}
 */
export function underCaps(list, paths) {
  /** @param {unknown} x */
  const isRule = x => !!x && typeof x === 'object' && !Array.isArray(x) && recordKind(/** @type {Record<string, unknown>} */ (x)) === 'rule'
  const rules = list.flatMap((x, i) => (isRule(x) ? [i] : []))
  const others = list.flatMap((x, i) => (isRule(x) ? [] : [i]))
  const kept = keptRecords(
    others.map(i => list[i]),
    paths,
    PRIOR_DECISIONS_MAX,
  )
  const read = [...others.filter((_, k) => kept[k]), ...rules.slice(0, PRIOR_DECISIONS_MAX)].sort((a, b) => a - b)
  return { read, cut: others.filter((_, k) => !kept[k]), cutRules: rules.slice(PRIOR_DECISIONS_MAX) }
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
export function titleWords(t) {
  return new Set(
    String(t ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
}

/**
 * Whether `d` answers finding `f` by the title rule alone: the file inside the scope, and the titles
 * overlapping enough. The engines apply it to a record or a finding without a comparable anchor
 * (integrations/shared/prior-decision-match.mjs; realm @nick/craft, node #230).
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
export function decisionAnswers(f, d) {
  return inDecisionScope(f.file, d.scope) && titleOverlap(f.title, d.title) >= DECISION_TITLE_OVERLAP
}

/** Whether `file` sits inside `scope` (by path segments; `.` covers the repo). @param {unknown} file @param {string} scope */
export function inDecisionScope(file, scope) {
  const parts = decisionScopeParts(String(file ?? ''))
  const within = decisionScopeParts(scope)
  return parts.length > 0 && within.length <= parts.length && within.every((s, i) => s === parts[i])
}

/** The share of words two titles share, of the longer one; 0 when either has none. @param {unknown} x @param {unknown} y @returns {number} */
export function titleOverlap(x, y) {
  const a = titleWords(x)
  const b = titleWords(y)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size)
}

/** Critical/High, which no deferred question holds (realm @nick/craft, node #187). @param {unknown} sev */
export function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? '').trim())
}

/**
 * Whether `d` is a human's decision: a decision that says `decidedBy: "human"` and records no deferral. A
 * record without the field is not one, so every record written before it is not.
 * @param {{ kind: string, deferred?: boolean, decidedBy?: string }} d
 */
export function humanDecision(d) {
  return d.kind === 'decision' && !d.deferred && d.decidedBy === 'human'
}

/**
 * Whether a finding's severity alone raises it again whatever record `d` says (realm @nick/craft, node #196):
 * a Critical always, a High unless `d` is a human's decision.
 * @param {unknown} sev @param {{ kind: string, deferred?: boolean, decidedBy?: string }} d
 */
export function reraisedByRank(sev, d) {
  const s = String(sev ?? '').trim()
  return /^critical$/i.test(s) || (/^high$/i.test(s) && !humanDecision(d))
}
