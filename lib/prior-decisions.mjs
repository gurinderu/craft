// Prior decisions on findings, handed to the review engine by the session that launched it: the
// project's recorded rejections ("not a bug here, because …"), recalled from whatever memory the
// project keeps (the `memory` skill) for the paths of the diff. The engine never drops a finding a
// decision answers — it sets it aside under its own section, marked with who rejected it, when, why
// and where. A finding is raised again normally when it is Critical or High, when the code in the
// decision's scope changed since the commit the decision was recorded at, or when that cannot be
// established. The engine recalls them itself on every launch and a passed list adds to that recall
// (lib/memory-recall.mjs; realm @nick/craft, node #218); a malformed one applies nothing and is named.
// This module reads the argument and matches; one decision is read by lib/prior-decision-record.mjs,
// scopes are checked by lib/prior-decision-scope.mjs and findings split by lib/prior-decision-apply.mjs.
// Inlined into src/review.js and src/adversarial-review.js after prior-decision-record.mjs.
import { DECISION_FIELD_MAX, decisionScopeParts, decisionText, hasControlChar, readPriorDecision } from './prior-decision-record.mjs'

// The most decisions one run applies — across the recalled and the passed records together (realm
// @nick/craft, node #218); the rest are refused by name and their findings raised normally.
export const PRIOR_DECISIONS_MAX = 100
// A decision answers a finding when the finding's file sits inside the decision's scope AND their
// titles share at least this share of words (of the longer one) (realm @nick/craft, node #187).
export const DECISION_TITLE_OVERLAP = 0.6

/**
 * @typedef {import('./prior-decision-record.mjs').PriorDecision} PriorDecision
 * @typedef {{ file?: unknown, title?: unknown, severity?: unknown, why?: unknown, tier?: unknown, [k: string]: unknown }} DecidableFinding
 */

/** A refusal's label for the record at index `i`. @param {number} i @returns {string} */
export const decisionLabel = i => `decision #${i}`

/** The record's id when it is fit to print, else ''. @param {unknown} item @returns {string} */
export function printableId(item) {
  const id = item && typeof item === 'object' ? decisionText(/** @type {Record<string, unknown>} */ (item)['id']) : ''
  return id && id.length <= DECISION_FIELD_MAX.id && !hasControlChar(id) ? id : ''
}

/**
 * The records past the cap, each named (its label and id), the names bounded by the cap itself.
 * @param {unknown[]} cut @param {(i: number) => string} labelOf @returns {string}
 */
export function cutNames(cut, labelOf) {
  const named = cut.slice(0, PRIOR_DECISIONS_MAX).map((item, k) => {
    const id = printableId(item)
    return `${labelOf(PRIOR_DECISIONS_MAX + k)}${id ? ` (${id})` : ''}`
  })
  const more = cut.length - named.length
  return `${named.join(', ')}${more ? ` and ${more} more` : ''}`
}

/**
 * The `priorDecisions` argument (or a recall's answer merged with it), checked. Absent → nothing of it applied, no refusal
 * (the engine's own recall still runs: lib/memory-recall.mjs). Anything else that is not a list → nothing applied, each problem named.
 * @param {unknown} raw @param {(i: number) => string} [labelOf] how a refusal names the record at index i
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
export function parsePriorDecisions(raw, labelOf = decisionLabel) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  // Only a list inside an object argument: in the key=value form a value cannot be delimited, and a
  // JSON string invites that form, so any string is refused (lib/workflow-args.mjs OBJECT_ONLY_OPTIONS; realm @nick/craft, node #183).
  if (typeof raw === 'string') return { decisions: [], refused: ['priorDecisions arrived as a string — only a list inside an object argument is read (in a key=value string nothing from priorDecisions on was read as an option) — no decision applied'] }
  const list = raw
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, labelOf(i))
    if (typeof d === 'string') refused.push(d)
    // The scope check answers by id: two decisions under one id could lend one's unchanged scope to
    // the other, so the second is refused.
    else if (decisions.some(x => x.id === d.id)) refused.push(`${labelOf(i)} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally: ${cutNames(list.slice(PRIOR_DECISIONS_MAX), labelOf)}`)
  }
  return { decisions, refused }
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
export function titleWords(t) {
  return new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * Whether `d` answers finding `f`: the file inside the scope, and the titles overlapping enough.
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
export function decisionAnswers(f, d) {
  const file = decisionScopeParts(String(f.file ?? ''))
  const scope = decisionScopeParts(d.scope)
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return false
  const a = titleWords(f.title)
  const b = titleWords(d.title)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP
}

/** Critical/High are always raised again (realm @nick/craft, node #187). @param {unknown} sev */
export function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? '').trim())
}

/**
 * The report section naming what of `priorDecisions` was not applied; empty when everything was.
 * @param {string[]} refused @returns {string}
 */
export function priorDecisionsRefusedSection(refused) {
  if (!refused.length) return ''
  return `\n\n## Prior decisions not applied\n${refused.map(r => `- ⚠️ ${r}`).join('\n')}\n`
}
