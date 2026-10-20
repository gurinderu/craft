// The sorting before publication (realm @nick/craft, node #270): each finding the review would post on a PR
// is a defect, posted as it is, or doubtful — its rightness depends on what the author knows — and goes to
// the human reviewer first, who chooses: ask the author, post it as a defect, or do not post (node #271).
// The first version is this deterministic rule, no agent (node #277): a finding is doubtful when any sign
// holds — not Confirmed; raised by the compat, intent or api-boundary lens; its title or reason speaks of
// rollback, rollout, old replicas, migration or a breaking change; its line outside the lines the diff
// changed. A finding a decision set aside or a project rule covered is not sorted (nodes #196, #273).
// Inlined into src/review.js after prior-decision-match.mjs and diff-lines.mjs.
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
  if (lineInDiff(changed, f.file, findingLine(f)) === false) out.push('its line is outside the lines the diff changed')
  return out
}

/**
 * The findings split for publication: `defect` posted as they are, `doubtful` each with its reasons. A
 * finding set aside by a decision or covered by a rule (it carries `priorDecision`) is in neither.
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
    const reasons = doubtReasons(f, changed)
    if (reasons.length) doubtful.push({ f, reasons })
    else defect.push(f)
  }
  return { defect, doubtful }
}

/** The fields a doubtful finding is posted from later (lib/finding-post.mjs), numbered from 1. @param {SortableFinding} f @param {number} i */
export function postable(f, i) {
  return { n: i + 1, severity: f.severity, title: f.title, file: f.file, line: findingLine(f), why: f.why, fix: f.fix, source: f.source ?? '', toolRule: f.toolRule ?? '' }
}

/**
 * The report section of the doubtful findings: numbered, each with why it is doubtful, then the list as
 * one JSON line the launcher posts a chosen one from. '' when none and nothing to say.
 * @param {Array<{ f: SortableFinding, reasons: string[] }>} doubtful @param {string} note why the outside-the-diff sign was not applied, or ''
 * @returns {string}
 */
export function doubtfulSection(doubtful, note) {
  if (!doubtful.length) return note ? `\n\n${DOUBTFUL_HEADING}\n- none · ⚠️ ${note}\n` : ''
  const lines = doubtful.map(({ f, reasons }, i) => `${i + 1}. ${String(f.severity ?? '')} · \`${String(f.file || '?')}:${findingLine(f)}\` · ${String(f.title ?? '')} · doubtful: ${reasons.join('; ')}`)
  return `\n\n${DOUBTFUL_HEADING}\n`
    + `Not posted on the PR: each waits for the reviewer's choice — ask the author (a question comment), post it as a defect, or do not post it. The sorting changes nothing in the verdict.${note ? ` ⚠️ ${note}` : ''}\n`
    + `${lines.join('\n')}\n\n`
    + `The same findings as data, for posting a chosen one:\n\`\`\`json\n${JSON.stringify(doubtful.map(({ f }, i) => postable(f, i)))}\n\`\`\`\n`
}
