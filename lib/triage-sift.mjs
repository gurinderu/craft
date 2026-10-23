// The sift triage-findings runs before it validates (realm @nick/craft, node #305): repeats inside one
// batch collapse onto one finding, and the project memory (recalled and passed records merged, node #218)
// answers what it already settled — a finding an active decision, deferred question or project rule
// answers leaves for the ledger without a validator, marked with who decided, when and where (node #196).
// What may leave that way is bounded (node #309): only a match the matcher and its judge make (node #230;
// tool rules, node #236); a Critical/High finding and a record whose scope changed since its commit are
// raised again, by the review engine's own split (lib/prior-decision-apply.mjs). A finding the judge shows
// going against a record is a `conflict` for a human.
// Inlined into src/triage-findings.js after prior-decision-apply.mjs and project-rule-apply.mjs.
import { SEVERITIES, shingleOverlap } from './run-record.mjs'
import { MATCH_SURE_WINDOW } from './prior-decision-match.mjs'
import { applyPriorDecisions } from './prior-decision-apply.mjs'
import { applyProjectRules } from './project-rule-apply.mjs'
import { contradictionOf } from './finding-sort.mjs'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {{ severity: string, title: string, location: string, detail: string, proposed_fix: string, thread_id: string, source: string }} GatheredFinding
 * @typedef {GatheredFinding & { stable_id: string, file: string, line: number, why: string, memoryNote: string }} SiftFinding
 * @typedef {{ stable_id: string, verdict: string, reason: string, sifted: true, action?: string }} SiftEntry
 */

// How much two titles at one site must share to be one finding said twice.
export const REPEAT_TITLE_OVERLAP = 0.6

// The mark every ledger row the sift settles carries in its reason: no validator read the code for it.
// The row also carries `sifted: true`, the field a reader tells it apart by: a re-run decides it afresh
// rather than carrying it, and the addressing-findings skill records no new decision for it.
export const SIFT_MARK = 'SIFTED BEFORE VALIDATION'

/**
 * The file and line a gathered location names: `path:line` (a `:col` or `-end` after it ignored); a
 * bare path keeps line 0; a PR-level or empty location names no file.
 * @param {unknown} location @returns {{ file: string, line: number }}
 */
export function locationParts(location) {
  const s = String(location ?? '').trim()
  const m = /^(\S+?):(\d+)(?:[-:]\d+)?$/.exec(s)
  if (m) return { file: String(m[1]), line: Number(m[2]) }
  return { file: /^\S+[./]\S*$/.test(s) ? s : '', line: 0 }
}

/**
 * A gathered finding as the memory matcher reads it: its stable id, file and line, and its detail as
 * the `why` the judge compares; `memoryNote` collects the marks the split appends.
 * @param {GatheredFinding} f @param {string} id @returns {SiftFinding}
 */
export function siftFinding(f, id) {
  const { file, line } = locationParts(f.location)
  return { ...f, stable_id: id, file, line, why: String(f.detail ?? ''), memoryNote: '' }
}

/** A severity's rank, Critical first; an unknown one last. @param {unknown} s @returns {number} */
export function severityRank(s) {
  const at = SEVERITIES.findIndex(x => x.toLowerCase() === String(s ?? '').trim().toLowerCase())
  return at < 0 ? SEVERITIES.length : at
}

/**
 * Whether `b` says `a` again: the same review thread, or the same file, lines within the sure window
 * when both carry one, and titles sharing most of their words.
 * @param {SiftFinding} a @param {SiftFinding} b @returns {boolean}
 */
export function repeatsFinding(a, b) {
  if (a.thread_id && a.thread_id === b.thread_id) return true
  if (!a.file || a.file !== b.file) return false
  if (a.line && b.line && Math.abs(a.line - b.line) > MATCH_SURE_WINDOW) return false
  return shingleOverlap(a.title, b.title) >= REPEAT_TITLE_OVERLAP
}

/**
 * The batch with each repeat collapsed onto one finding — the most severe of them, so a repeat never
 * lowers what goes on — and every repeat with the id it was collapsed onto.
 * @param {SiftFinding[]} findings @returns {{ kept: SiftFinding[], repeated: Array<{ f: SiftFinding, of: string }> }}
 */
export function collapseRepeats(findings) {
  /** @type {SiftFinding[]} */
  const kept = []
  /** @type {Array<{ f: SiftFinding, of: string }>} */
  const repeated = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (const f of findings) {
    // The same id twice is one finding gathered twice: the ledger keys by id, so it is kept once.
    if (seen.has(f.stable_id)) continue
    seen.add(f.stable_id)
    const at = kept.findIndex(k => repeatsFinding(k, f))
    const k = kept[at]
    if (!k) { kept.push(f); continue }
    if (severityRank(f.severity) >= severityRank(k.severity)) { repeated.push({ f, of: k.stable_id }); continue }
    kept[at] = f
    for (const r of repeated) if (r.of === k.stable_id) r.of = f.stable_id
    repeated.push({ f: k, of: f.stable_id })
  }
  return { kept, repeated }
}

/** The ledger row of a repeat. @param {{ f: SiftFinding, of: string }} r @returns {SiftEntry} */
export function repeatEntry(r) {
  return { stable_id: r.f.stable_id, verdict: 'reject', sifted: true, reason: `${SIFT_MARK} — repeats ${r.of} in this batch (same site, same title words); judged there` }
}

/**
 * The ledger row of a finding a record set aside: a deferred question's is `defer`, a decision's or a
 * rule's `reject`, the reason the record's own mark (who, when, link) and how it was matched.
 * @param {SiftFinding & { priorKind: string, priorMatch: string }} f @returns {SiftEntry}
 */
export function setAsideEntry(f) {
  const mark = String(f.memoryNote ?? '').replace(/^\s*·\s*/, '')
  return { stable_id: f.stable_id, verdict: f.priorKind === 'question' ? 'defer' : 'reject', sifted: true, reason: `${SIFT_MARK} — ${mark} · ${f.priorMatch}` }
}

/** The ledger row of a finding going against a record. @param {SiftFinding & { memoryContradicts?: unknown }} f @returns {SiftEntry} */
export function conflictEntry(f) {
  const c = contradictionOf(f)
  return { stable_id: f.stable_id, verdict: 'conflict', sifted: true, reason: `${SIFT_MARK} — goes against ${c?.kind ?? 'record'} ${c?.id ?? '?'} in project memory (${c?.why ?? ''}); a human decides whether the record still stands` }
}

/**
 * Sifts the batch by the records: the findings left for the validator (a raised one carries its note in
 * `memoryNote`), the ledger rows of everything settled here, and what the report names. `checkScopes`,
 * `judge` and `ruleJudge` are the review engine's scope-check, match-judge and rule-judge agents.
 * @param {SiftFinding[]} findings @param {PriorDecision[]} records
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes
 * @param {(prompt: string) => Promise<unknown>} judge @param {(prompt: string) => Promise<unknown>} ruleJudge
 * @returns {Promise<{ toValidate: SiftFinding[], ledger: SiftEntry[], notes: string[], notices: string[], refused: string[], counts: Record<string, number> }>}
 */
export async function siftByMemory(findings, records, checkScopes, judge, ruleJudge) {
  const prior = await applyPriorDecisions({ sift: findings }, records, checkScopes, 'memoryNote', judge)
  const ruled = await applyProjectRules(prior.tiers, records, 'memoryNote', ruleJudge)
  const left = ruled.tiers['sift'] ?? []
  const conflicts = left.filter(f => contradictionOf(f))
  const setAside = [...prior.setAside, ...ruled.covered]
  return {
    toValidate: left.filter(f => !contradictionOf(f)),
    ledger: [...setAside.map(setAsideEntry), ...conflicts.map(conflictEntry)],
    notes: [...prior.notes, ...ruled.notes],
    notices: ruled.notices,
    refused: prior.refused,
    counts: {
      rejectedBefore: prior.setAside.filter(f => f.priorKind !== 'question').length,
      deferred: prior.setAside.filter(f => f.priorKind === 'question').length,
      covered: ruled.covered.length,
      conflict: conflicts.length,
      reraised: prior.reraised,
    },
  }
}
