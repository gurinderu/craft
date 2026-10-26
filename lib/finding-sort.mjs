// The sorting before publication (realm @nick/craft, node #270): each finding the review would post on a PR
// is a defect, posted as it is, or doubtful — its rightness depends on what the author knows — and goes to
// the human reviewer first, who chooses: ask the author, post it as a defect, or do not post (node #271).
// The first version is this deterministic rule, no agent (node #277): a finding is doubtful when any sign
// holds — not Confirmed; raised by the compat, intent or api-boundary lens; its title or reason speaks of
// rollback, rollout, old replicas, migration or a breaking change; its line outside the lines the diff
// changed. A finding a decision set aside or a project rule covered is not sorted (nodes #196, #273).
// Memory outranks the signs: a finding the memory judges marked as going against an active record (its
// `memoryContradicts`; lib/memory-contradiction.mjs) is a certain defect, whatever sign holds (node #282).
// Imported by src/review.js.
import { findingLenses, findingLine } from './prior-decision-match.mjs'
import { lineInDiff } from './diff-lines.mjs'

/** @typedef {import('./diff-lines.mjs').ChangedLines} ChangedLines */
/**
 * @typedef {{ severity?: unknown, title?: unknown, why?: unknown, fix?: unknown, file?: unknown, line?: unknown,
 *   tier?: unknown, source?: unknown, sources?: unknown, toolRule?: unknown, priorDecision?: unknown, [k: string]: unknown }} SortableFinding
 */

// The lenses whose findings turn on the author's intent or on parties outside the diff.
export const DOUBT_LENSES = ['compat', 'intent', 'api-boundary']
// Rollback, rollout, old replicas, migration, a breaking change — in the title or the reason.
export const DOUBT_WORDS = /\b(?:roll(?:ed|ing)?[ -]?backs?|roll(?:ed|ing)?[ -]?outs?|rolling (?:deploy|upgrade|update|restart)s?|(?:old|older|stale) replicas?|migrat(?:e|es|ed|ing|ion|ions)|breaking[ -]changes?)\b/i
export const DOUBTFUL_HEADING = '## Doubtful — for the reviewer, not posted'
export const OUTSIDE_REASON = 'its line is outside the lines the diff changed'

/**
 * Why a finding is doubtful, one reason per sign that holds; empty — a defect. `changed` null: the
 * outside-the-diff sign cannot be told and is not applied.
 * @param {SortableFinding} f @param {ChangedLines | null} changed @returns {string[]}
 */
export function doubtReasons(f, changed) {
  const tier = String(f.tier ?? 'confirmed').toLowerCase()
  const lenses = [...findingLenses(f)].filter(l => DOUBT_LENSES.includes(l))
  /** @type {string[]} */
  const out = []
  if (tier !== 'confirmed') out.push(`not confirmed (${tier})`)
  if (lenses.length) out.push(`raised by the ${lenses.join(', ')} lens`)
  if (DOUBT_WORDS.test(`${String(f.title ?? '')} ${String(f.why ?? '')}`)) out.push('it speaks of rollback, rollout, old replicas, migration or a breaking change')
  if (lineInDiff(changed, f.file, findingLine(f)) === false) out.push(OUTSIDE_REASON)
  return out
}

/**
 * The record a finding was marked as going against — its id, kind and the judge's why — or null when it
 * carries no well-formed mark (realm @nick/craft, node #282). @param {SortableFinding} f
 * @returns {{ id: string, kind: string, why: string } | null}
 */
export function contradictionOf(f) {
  const m = f['memoryContradicts']
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const o = /** @type {Record<string, unknown>} */ (m)
  return typeof o['id'] === 'string' && o['id'] ? { id: o['id'], kind: String(o['kind'] ?? ''), why: String(o['why'] ?? '') } : null
}

/**
 * The findings split for publication: `defect` posted as they are, `doubtful` each with its reasons. A
 * finding set aside by a decision or covered by a rule (it carries `priorDecision`) is in neither; one
 * going against a memory record is a defect before any sign is read.
 * @template {SortableFinding} F @param {F[]} findings @param {ChangedLines | null} changed
 * @returns {{ defect: F[], doubtful: Array<{ f: F, reasons: string[] }> }}
 */
export function sortFindings(findings, changed) {
  /** @type {F[]} */
  const defect = []
  /** @type {Array<{ f: F, reasons: string[] }>} */
  const doubtful = []
  for (const f of findings) {
    if (typeof f.priorDecision === 'string' && f.priorDecision) continue
    if (contradictionOf(f)) { defect.push(f); continue }
    const reasons = doubtReasons(f, changed)
    if (reasons.length) doubtful.push({ f, reasons })
    else defect.push(f)
  }
  return { defect, doubtful }
}

/**
 * A doubtful finding as the run record keeps it, numbered from 1: what lib/finding-post.mjs builds its
 * comment from, and whether its line is outside the diff (then only a file-level comment can carry it).
 * @param {SortableFinding} f @param {number} i @param {string[]} reasons
 */
export function postable(f, i, reasons) {
  return {
    n: i + 1, severity: String(f.severity ?? ''), title: String(f.title ?? ''), file: String(f.file ?? ''), line: findingLine(f),
    why: String(f.why ?? ''), fix: String(f.fix ?? ''), source: String(f.source ?? ''), toolRule: String(f.toolRule ?? ''), outsideDiff: reasons.includes(OUTSIDE_REASON),
  }
}

/**
 * The report section of the doubtful findings: numbered, each with why it is doubtful; the run record
 * keeps them by the same numbers for posting a chosen one. '' when none and nothing to say.
 * @param {Array<{ f: SortableFinding, reasons: string[] }>} doubtful @param {string} note why the outside-the-diff sign was not applied, or ''
 * @returns {string}
 */
export function doubtfulSection(doubtful, note) {
  if (!doubtful.length) return note ? `\n\n${DOUBTFUL_HEADING}\n- none · ⚠️ ${note}\n` : ''
  const lines = doubtful.map(({ f, reasons }, i) => `${i + 1}. ${String(f.severity ?? '')} · \`${String(f.file || '?')}:${findingLine(f)}\` · ${String(f.title ?? '')} · doubtful: ${reasons.join('; ')}`)
  return `\n\n${DOUBTFUL_HEADING}\n`
    + `Not posted on the PR: each waits for the reviewer's choice — ask the author (a question comment), post it as a defect, or do not post it. The sorting changes nothing in the verdict.${note ? ` ⚠️ ${note}` : ''}\n`
    + `${lines.join('\n')}\n`
}
