// Which project rule covers a finding (realm @nick/craft, node #273): the candidates and the judge. A
// rule is a stance on a whole class of findings ("we do not support rollback"), so it is not matched like
// a decision (the "same defect" judge, lib/prior-decision-match.mjs; node #230): its candidates are the
// findings whose file sits inside the rule's scope — and, when the rule names a lens, only that lens's —
// and ONE cheap judge per run is asked whether each finding's concern is exactly what the rule declares
// acceptable. A pair the judge gave no verdict (dead, unreadable, past the bound) is not covered: silence
// never removes a finding. What the judge sees is quoted data, never the rule's body, as for the
// decision judge (node #231).
// Imported by src/triage-findings.js.
import { inDecisionScope, reraisedBySeverity } from './prior-decisions.mjs'
import { MATCH_BODY_MAX, clipLine, findingLenses, findingLine, lensWords, readJudge } from './prior-decision-match.mjs'
import ruleJudgeSchema from '../content/schemas/rule-judge.schema.json' with { type: 'json' }
import { render } from './content.mjs'
import ruleJudgeTpl from '../content/prompts/rule-judge.md'

// The most rule–finding pairs one judge sees; the rest are named and not covered.
export const RULE_JUDGE_PAIRS_MAX = 40

/**
 * @typedef {import('./prior-decisions.mjs').PriorDecision} PriorDecision
 * @typedef {import('./prior-decisions.mjs').DecidableFinding} DecidableFinding
 * @typedef {{ f: DecidableFinding, r: PriorDecision }} RulePair
 */

/** Whether a finding is Critical — raised even under a rule. @param {unknown} sev */
export function isCritical(sev) {
  return /^critical$/i.test(String(sev ?? '').trim())
}

/**
 * Whether rule `r` may cover finding `f`: the finding's file inside the rule's scope, and, when the rule
 * names a lens, the finding raised by it. @param {DecidableFinding} f @param {PriorDecision} r @returns {boolean}
 */
export function ruleCandidate(f, r) {
  if (r.kind !== 'rule' || !inDecisionScope(f.file, r.scope)) return false
  const own = lensWords(r.lens)
  const lenses = findingLenses(f)
  return !own.length || own.some(l => lenses.has(l))
}

/**
 * Every candidate pair, in the order the judge's bound keeps them: findings a rule can cover before
 * Critical and High ones (a Critical is raised whatever the verdict), each finding's rules in the given order.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} rules @returns {RulePair[]}
 */
export function rulePairs(findings, rules) {
  const pairs = findings.flatMap(f => rules.filter(r => ruleCandidate(f, r)).map(r => ({ f, r })))
  /** @param {RulePair} p */
  const rank = p => (isCritical(p.f.severity) ? 2 : reraisedBySeverity(p.f.severity) ? 1 : 0)
  return pairs.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p)
}

// What the judge returns: one verdict per pair.
export const RULE_JUDGE_SCHEMA = ruleJudgeSchema

/** One pair as the judge reads it: quoted data, the rule's body left out. @param {RulePair} p @param {number} i */
export function rulePair(p, i) {
  const { f, r } = p
  return {
    pair: i,
    rule: { id: r.id, rule: clipLine(r.title), scope: r.scope, lens: clipLine(r.lens) },
    finding: { severity: clipLine(f.severity), title: clipLine(f.title), file: clipLine(f.file), line: findingLine(f), lens: clipLine([...findingLenses(f)].join(', ')), body: clipLine(f['why'] ?? f['description'], MATCH_BODY_MAX) },
  }
}

/** The judge's prompt; the pairs are one JSON block of quoted data. The Rust CLI renders the same template (content/parity/prompt-cases.json). @param {RulePair[]} pairs @returns {string} */
export function ruleJudgePrompt(pairs) {
  return render(ruleJudgeTpl, { pairs: JSON.stringify(pairs.map(rulePair)) })
}

/**
 * Runs the judge over `sent` (never empty): the verdicts by pair index, `covered` read as `same`; a
 * missing judge, a throw or an unreadable answer yields none, and `why` says which.
 * @param {RulePair[]} sent @param {((prompt: string) => Promise<unknown>) | undefined} judge
 * @returns {Promise<{ verdicts: Map<number, import('./prior-decision-match.mjs').JudgeVerdict>, why: string }>}
 */
export async function askRuleJudge(sent, judge) {
  /** @type {unknown} */
  let raw = null
  try { raw = judge ? await judge(ruleJudgePrompt(sent)) : null } catch { raw = null }
  const v = readJudge(raw, sent.length, 'covered')
  return v ? { verdicts: v, why: 'the rule judge returned no verdict for it' } : { verdicts: new Map(), why: 'the rule judge died or answered unreadably' }
}
