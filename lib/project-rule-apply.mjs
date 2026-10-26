// Applying the project rules (kind `rule`, realm @nick/craft, node #273) to an engine's findings, after
// the prior decisions set theirs aside (lib/prior-decision-apply.mjs): a finding the rule judge
// (lib/project-rule-judge.mjs) puts under a rule leaves the verdict — and so the PR comments, which are
// posted from the verdict's findings — and is listed under its own report section with the rule's id,
// its statement and the judge's why. A Critical finding is raised even under a rule, and named there as
// raised; a finding whose pair got no verdict stays in the verdict, and the section says why.
// A rule another given record supersedes or answers no longer applies, as for a decision; a passed rule the
// store names inactive never reaches here (lib/memory-recall.mjs holds it back).
// A finding the judge says goes against a rule — not covered — stays in the verdict marked with the rule
// (memoryContradicts; lib/memory-contradiction.mjs, realm @nick/craft, node #282), unless a decision marked it first.
// Imported by src/review.js and src/adversarial-review.js.
import { RULE_JUDGE_PAIRS_MAX, askRuleJudge, isCritical, rulePairs } from './project-rule-judge.mjs'
import { CUT_NAMED_MAX, clipLine, findingLine } from './prior-decision-match.mjs'
import { recordAliases } from './prior-decision-apply.mjs'
import { markContradicting } from './memory-contradiction.mjs'

export const PROJECT_RULE_HEADING = '## Covered by project rules (not in the verdict)'

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 */
/**
 * A finding a rule covers: its tier, the rule's id under `priorDecision` (as a set-aside finding carries
 * its record's), kind `rule`, the judge's why under `priorMatch`, and the rule's statement.
 * @template F @typedef {F & { priorTier: string, priorDecision: string, priorKind: 'rule', priorMatch: string, ruleTitle: string }} Covered
 */

/** A finding as a notice names it. @param {DecidableFinding} f @returns {string} */
export function ruleFindingName(f) {
  return `"${clipLine(f.title, 60)}" @ ${clipLine(f.file)}:${findingLine(f)}`
}

/**
 * The verdicts read per finding: the first rule (in pair order) the judge put it under, the first it says
 * the code goes against (`against`, realm @nick/craft, node #282), and for a finding with a pair the judge
 * gave no verdict, why. @param {Array<{ f: DecidableFinding, r: PriorDecision }>} pairs
 * @param {number} sent how many pairs went to the judge @param {{ verdicts: Map<number, import('./prior-decision-match.mjs').JudgeVerdict>, why: string }} answer
 */
export function ruleVerdicts(pairs, sent, answer) {
  /** @type {Map<DecidableFinding, { r: PriorDecision, why: string }>} */
  const covers = new Map()
  /** @type {Map<DecidableFinding, string>} */
  const unjudged = new Map()
  pairs.forEach((p, i) => {
    const v = i < sent ? answer.verdicts.get(i) : undefined
    if (v?.same && !covers.has(p.f)) covers.set(p.f, { r: p.r, why: v.why })
    if (!v && !unjudged.has(p.f)) unjudged.set(p.f, i < sent ? answer.why : `past the rule judge's bound of ${RULE_JUDGE_PAIRS_MAX} pairs`)
  })
  return { covers, against: ruleContradictions(pairs, answer), unjudged }
}

/**
 * The first rule (in pair order) the judge says each finding's code goes against (node #282).
 * @param {Array<{ f: DecidableFinding, r: PriorDecision }>} pairs @param {{ verdicts: Map<number, import('./prior-decision-match.mjs').JudgeVerdict> }} answer
 * @returns {Map<DecidableFinding, { d: PriorDecision, why: string }>}
 */
export function ruleContradictions(pairs, answer) {
  /** @type {Map<DecidableFinding, { d: PriorDecision, why: string }>} */
  const against = new Map()
  pairs.forEach((p, i) => {
    const v = answer.verdicts.get(i)
    if (v?.violates && !against.has(p.f)) against.set(p.f, { d: p.r, why: v.why })
  })
  return against
}

/** One notice per reason: the findings left in the verdict for want of a verdict, each named once. @param {Map<DecidableFinding, string>} unjudged @returns {string[]} */
export function unjudgedNotices(unjudged) {
  /** @type {Map<string, DecidableFinding[]>} */
  const byWhy = new Map()
  for (const [f, why] of unjudged) byWhy.set(why, [...(byWhy.get(why) ?? []), f])
  return [...byWhy].map(([why, fs]) => {
    const more = fs.length - CUT_NAMED_MAX
    return `${fs.length} finding(s) in a project rule's scope NOT covered — ${why}, so they stay in the verdict: ${fs.slice(0, CUT_NAMED_MAX).map(ruleFindingName).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  })
}

/**
 * The rules among `records` that apply, and those another given record supersedes or answers (by any of
 * their aliases), which do not. @param {PriorDecision[]} records
 */
export function activeRules(records) {
  const replaced = new Set(records.flatMap(d => d.supersedes))
  const rules = records.filter(d => d.kind === 'rule')
  /** @param {PriorDecision} d */
  const isReplaced = d => recordAliases(d).some(id => replaced.has(id))
  return { rules: rules.filter(d => !isReplaced(d)), superseded: rules.filter(isReplaced).map(d => d.id) }
}

/**
 * Applies the rules among `records` to every tier. `judge` is the one rule judge, called only when a
 * candidate pair exists. `notices` are the section's warnings (a Critical raised, a finding left for want
 * of a verdict); `notes` the log lines. @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} records @param {string} [noteField] `why` in review, `description` in adversarial-review
 * @param {(prompt: string) => Promise<unknown>} [judge]
 * @returns {Promise<{ tiers: Record<string, F[]>, covered: Array<Covered<F>>, notices: string[], notes: string[], rules: number }>}
 */
export async function applyProjectRules(tiers, records, noteField = 'why', judge = undefined) {
  const { rules, superseded } = activeRules(records)
  const gone = superseded.length ? [`${superseded.length} project rule(s) superseded by another given record — not applied: ${superseded.join(', ')}`] : []
  const pairs = rulePairs(Object.values(tiers).flat(), rules)
  if (!pairs.length) return { tiers, covered: [], notices: [], notes: [...gone, ...(rules.length ? [`${rules.length} project rule(s) given, no finding in their scope`] : [])], rules: rules.length }
  const sent = Math.min(pairs.length, RULE_JUDGE_PAIRS_MAX)
  const { covers, against, unjudged } = ruleVerdicts(pairs, sent, await askRuleJudge(pairs.slice(0, sent), judge))
  /** @type {Array<Covered<F>>} */
  const covered = []
  /** @type {string[]} */
  const notices = []
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    out[tier] = list.flatMap(f => {
      const c = covers.get(f)
      if (!c) return [markContradicting(f, against.get(f))]
      const note = `${String(f[noteField] ?? '')} · `
      if (isCritical(f.severity)) {
        notices.push(`Critical ${ruleFindingName(f)} RAISED — a Critical finding is raised even under rule ${c.r.id} "${clipLine(c.r.title)}" (judge: ${c.why})`)
        return [{ ...f, [noteField]: `${note}Raised under project rule ${c.r.id}: a Critical finding is never covered by a rule.` }]
      }
      covered.push({ ...f, priorTier: String(f.tier || tier), priorDecision: c.r.id, priorKind: /** @type {const} */ ('rule'), priorMatch: `covered by judge: ${c.why}`, ruleTitle: c.r.title, [noteField]: `${note}COVERED BY PROJECT RULE: ${c.r.title} (rule ${c.r.id})` })
      return []
    })
  }
  notices.push(...unjudgedNotices(new Map([...unjudged].filter(([f]) => !covers.has(f)))))
  const notes = [...gone, `${rules.length} project rule(s) given, ${pairs.length} rule–finding pair(s), ${covered.length} finding(s) covered${against.size ? `, ${against.size} showing the code against a rule` : ''}`]
  return { tiers: out, covered, notices, notes, rules: rules.length }
}

/**
 * The report section of what the rules covered, one line per finding with the rule's id, its statement
 * and the judge's why, then the notices; '' when there is neither.
 * @param {Array<DecidableFinding & { priorKind?: unknown, priorDecision?: unknown, priorMatch?: unknown, ruleTitle?: unknown }>} covered @param {string[]} notices @returns {string}
 */
export function projectRuleSection(covered, notices) {
  const own = covered.filter(f => f.priorKind === 'rule')
  if (!own.length && !notices.length) return ''
  /** @param {DecidableFinding & { priorDecision?: unknown, priorMatch?: unknown, ruleTitle?: unknown }} f */
  const line = f => `- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${String(f['line'] || 0)}\` · ${String(f.title ?? '')} · rule ${String(f.priorDecision ?? '?')} "${clipLine(f.ruleTitle)}" · ${String(f.priorMatch ?? '')}`
  return `\n\n${PROJECT_RULE_HEADING}\n${[...own.map(line), ...notices.map(n => `- ⚠️ ${n}`)].join('\n')}`
}
