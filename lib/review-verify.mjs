// The verification stage of the review engine (src/review.js): the verifier prompts, the routing of a finding to
// the cheapest treatment that cannot change its outcome, and the tier its votes decide. The prompts' text is in
// content/prompts/verify*.md (lib/content.mjs, realm @nick/craft, node #452).
import { sanitizeAttack } from './review-adjudicate.mjs'
import { flattenField, promptFields } from './prompt-fields.mjs'
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'
import { withoutPathFloorNote } from './path-severity-floor.mjs'
import { repoRuleVerifyLine } from './harm-repo-rule.mjs'
import { harmVerifyLine, HARM_QUESTION, panelHarm } from './harm-verify.mjs'
import { render } from './content.mjs'
import verifyTpl from '../content/prompts/verify.md'
import verifyGateTpl from '../content/prompts/verify-gate.md'
import verifyHeadToolTpl from '../content/prompts/verify-head-tool.md'
import verifyHeadSkepticTpl from '../content/prompts/verify-head-skeptic.md'
import verifyExclusionCatalogTpl from '../content/prompts/verify-exclusion-catalog.md'
import verifyBatchTpl from '../content/prompts/verify-batch.md'
import verifyBatchFindingTpl from '../content/prompts/verify-batch-finding.md'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-schemas.mjs').VerdictAnswer} Vote  one verifier verdict (model output, VERDICT_SCHEMA or one BATCH_VERDICT_SCHEMA entry)
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 */

// One-notch severity demotion (test-only reachability).
/** @type {Record<string, string>} */
export const DEMOTE = { Critical: 'High', High: 'Medium', Medium: 'Low', Low: 'Info', Info: 'Info' }

// `profile` is threaded in for the exclusion catalog: it is per-profile (only the rust rubric ships
// an fp-rules.md today), and naming a file the nix reviewer does not have would send it hunting.
// `sharedExclusions` is the language-independent catalog every profile reads (sharedExclusionsLine,
// realm @nick/craft, node #379); '' leaves it out.
// `sources` is the run's EXTERNAL SOURCES block (lib/review-external-sources.mjs, realm @nick/craft, node #430); '' when none.
/** @param {Finding} f @param {number} idx @param {boolean} isTool @param {string} gateProvenance @param {Profile} profile @param {string} [sharedExclusions] @param {string} [sources] */
export function verifyPrompt(f, idx, isTool, gateProvenance, profile, sharedExclusions = '', sources = '') {
  // Model-authored fields enter this prompt as context — guard them the same way the adjudicate track
  // does: flatten identifier/locator fields via promptFields (newline is the single-value injection
  // vector; identifier chars are load-bearing for the grep) and markdown-strip the prose (why/source).
  const pf = promptFields(f)
  const src = sanitizeAttack(f['source'])
  return render(verifyTpl, {
    head: verifyHead(isTool, idx, src),
    ...findingFields(f, pf, src, '(none — the finding claims to be self-contained at the cited line)'),
    gate: gateProvenance ? ` ${render(verifyGateTpl, { provenance: flattenField(gateProvenance) })}` : '',
    toolFallback: isTool ? ' If you STILL cannot run the tool, set refuted=false — an unverifiable tool finding stays alive.' : ' If no tool applies, judge it yourself.',
    exclusions: `${sharedExclusions}${exclusionCatalogText(profile)}`,
    sources,
    refutedRule: isTool ? 'Tool-decided as above.' : 'Mechanical check first, then your judgement; when uncertain about the claim, refuted=true.',
    dependencySource: DEPENDENCY_SOURCE_HOW,
    harmQuestion: HARM_QUESTION,
  })
}

/**
 * The lines that state one finding to a verifier, its model-authored fields guarded.
 * @param {Finding} f @param {ReturnType<typeof promptFields>} pf @param {string} src  its sanitized source
 * @param {string} selfContained  what stands for an empty whereChecked
 */
function findingFields(f, pf, src, selfContained) {
  return {
    severity: pf.severity, title: pf.title, at: `${pf.file || '?'}:${f['line'] || 0}`, why: sanitizeAttack(f['why']), source: src,
    rule: f['ruleId'] ? ` · rule ${pf.ruleId}` : '',
    evidence: f['whereChecked'] ? pf.whereChecked : selfContained,
    repoRule: repoRuleVerifyLine(f), harm: harmVerifyLine(f),
  }
}

/** The exclusion-catalog paragraph of a verify prompt, empty for a profile without one. @param {Profile} profile */
export function exclusionCatalogText(profile) {
  return profile?.fpRules
    ? `\n${render(verifyExclusionCatalogTpl, { rubricSkill: profile.rubricSkill, fpRules: profile.fpRules })}\n`
    : ''
}

/** @param {boolean} isTool @param {number} idx @param {string} src */
export function verifyHead(isTool, idx, src) {
  return render(isTool ? verifyHeadToolTpl : verifyHeadSkepticTpl, { n: String(idx + 1), source: src })
}

// ---- verification budget ----
// Verification is ~2/3 of a review's entire cost and scales linearly with finding count, uncapped:
// one measured run spent 154 agents / 21MB of transcript on 111 findings. Route each finding to the
// cheapest treatment that cannot change its outcome.
//
// INDIVIDUAL — Critical/High, plus any severity carrying a rule from a family that blocks on sight.
// These decide the verdict and get the full adversarial panel, never batched, never skipped.
// BATCHED — Medium. Can only reach Warning, so one agent judges a group of them instead of one each.
// SKIPPED — Low/Info. No combination of verdicts on these can move Approve/Warning/Block, so no
// verifier is spent on them. They then carry the `unverified` tier and say so in the report: an
// unexamined finding is neither confirmed nor suspected, and it is excluded from the verification
// counters, because a denominator that includes what was never checked makes the refutation rate of
// one run incomparable with another's. The residual risk is a lens UNDER-calling
// severity, which the blocking-family escape hatch below covers for the families where it would hurt.
// The escape hatch belongs ONLY on the skipped tier. Batching is still verification — a Medium the
// lens under-called gets a real adversarial judgement either way — so the only place an under-call
// goes unexamined is `skip`. A first attempt keyed on the whole SAF/ERR/CON *families* dragged most
// of a Rust review back into individual treatment (measured: 88 of 137 agents, 49% of transcript
// volume, wiping out the saving) because those families cover unwrap, dropped errors and every
// concurrency rule. Key it on the specific CRITICAL-tier rules instead, and only when the lens
// filed them at Low/Info — that combination *is* the under-call, and it is rare.
export const CRITICAL_TIER_RULES = new Set(['SAF-001', 'SAF-002', 'SAF-003', 'SAF-004', 'SAF-005', 'SAF-006', 'SAF-008', 'ERR-001', 'ERR-002'])

export const BATCH_SIZE = 6

/** @param {Finding} f */
export function verifyTier(f) {
  if (f['severity'] === 'Critical' || f['severity'] === 'High') return 'individual'
  if (f['severity'] === 'Medium') return 'batch'
  // Low/Info: skipped, unless the rule it cites is one that blocks on sight — then the severity is
  // more likely a mislabel than a judgement, and it is worth one verifier to find out.
  return CRITICAL_TIER_RULES.has(f['ruleId'] || '') ? 'individual' : 'skip'
}

// ---- the ONE route every death on the verification path takes -------------------------------
// The invariant, stated once: NO death on the verification path may give a finding a tier that
// asserts an inspection, may leave it inside the refutation denominator, or may leave it out of
// `notRun`. The deaths are enumerated rather than discovered one at a time, because the previous
// round of this fix closed the `.catch` branch alone and the dominant death is not a throw:
//   1. the verifier THREW            (both `ragent` attempts rejected, or the budget throw)
//   2. `ragent` returned `null`      (API error / skip, after its one re-dispatch)
//   3. `ragent` returned `null`      (per-agent deadline hit — DEADLINE_HIT, same shape)
//   4. a live answer with NO verdicts (`{verdicts: []}` — nothing was judged)
//   5. a live answer that is not a verdict list at all (schema drift)
//   6. `null` lost by the sliding window (`weightedWindow` writes null for a rejected entry)
//   7. every vote of an individual panel dead (tierFromVotes with an empty vote list)
//   8. a LIVE individual vote that is not a verdict at all (schema drift on the individual path —
//      the ninth door: it does not merely mislabel the finding, it DELETES it, because every absent
//      boolean reads as `false` and `citedLineMatches:false` alone means `refuted`)
// The distinction that MUST survive: "the agent never answered" (any of the above → not verified)
// versus "the agent answered but said nothing about THIS finding" (a lost finding → it was part of
// an inspection, so it keeps `suspected`). The discriminator is exactly this: a null/empty/malformed
// answer is a dead agent; a non-empty verdict list missing one index is a lost finding.
/** @type {(f: Finding, why: string) => Finding} */
export const NOT_VERIFIED = (f, why) => ({ ...f, tier: 'unverified', why: `${f['why']} (NOT VERIFIED: ${why})` })

// A vote is a JUDGEMENT only if it carries the four booleans tierFromVotes decides on. THE NINTH
// DOOR: the agent wrapper returns ANY non-null value verbatim, so an off-schema object reaches the
// vote arithmetic, where every missing boolean reads as `false` — `citedLineMatches` false alone
// makes the tier `refuted`, and a refuted finding is FILTERED OUT of the run. That is strictly worse
// than every other death on this path: the others keep the finding, this one deletes it — out of
// confirmed, out of suspected, out of unverified, still inside the refutation denominator, and
// absent from `notRun`. The batch path had this guard (batchDeath, ex-verifierAnswered); the
// individual path had none, so schema drift on a Critical silently became a refutation.
/** @type {Array<'refuted' | 'citedLineMatches' | 'reachable' | 'premiseSupported'>} */
export const VOTE_AXES = ['refuted', 'citedLineMatches', 'reachable', 'premiseSupported']

/** @param {unknown} v  a verifier's answer, typed or not: the schema is not trusted here @returns {v is Vote} */
export function isVerdictShaped(v) {
  return !!v && typeof v === 'object' && VOTE_AXES.every(k => typeof (/** @type {Record<string, unknown>} */ (v))[k] === 'boolean')
}

// Do two verdicts say the same thing on every axis tierFromVotes reads? Only then can the opening
// pair stand in for the full panel — a disagreement on ANY axis (not just `refuted`) can move the
// tier, because citedLineMatches gates refutation outright and reachable/premiseSupported demote.
/** @param {Vote | null | undefined} a @param {Vote | null | undefined} b */
export function votesAgree(a, b) {
  // An off-schema vote is not agreement either: two of them would `Boolean(undefined)`-match on every
  // axis and short-circuit the panel on garbage.
  if (!isVerdictShaped(a) || !isVerdictShaped(b)) return false
  return VOTE_AXES.every(k => a[k] === b[k])
}

// The majority arithmetic itself, over the SHAPED votes `v` (`live` is only needed to tell an
// all-dead panel from an all-off-schema one). `tierFromVotes` below is the entry point.
/** @param {Finding} f @param {unknown[]} live @param {Vote[]} v @returns {Finding} */
export function decideTier(f, live, v) {
  // EVERY vote died. This is not a judgement and must never be rendered as one: `suspected` is
  // defined in the report as "a verifier looked and the claim did not stand up", so handing it to a
  // finding nothing looked at asserts an inspection that never happened — and, worse, keeps the
  // finding inside the refute denominator and OUT of `notRun`, so a dead panel silently demotes a
  // Critical to a non-gating finding and the verdict does not read as incomplete.
  // One route for every death (see NOT_VERIFIED / verifyDeath): unverified tier, out of the
  // denominator, into notRun.
  if (!v.length) {
    return NOT_VERIFIED(f, live.length
      ? 'the verifier ANSWERED OFF-SCHEMA — its verdict carried none of the judgements this tier is decided on, so nothing was checked against the code'
      : 'every verifier vote for this finding died before returning a verdict — nothing was checked against the code')
  }
  const { tier, premiseOk, reach } = votePanel(v)
  if (tier === 'confirmed' && !premiseOk) return premiseDemoted(f)
  if (tier === 'confirmed' && !reach) return reachDemoted(f, tier)
  // Only a confirmed finding no demotion touched carries a verified harm (lib/harm-verify.mjs, realm @nick/craft, node #407).
  const harmVerified = tier === 'confirmed' ? panelHarm(f, v) : undefined
  return harmVerified === undefined ? { ...f, tier } : { ...f, tier, harmVerified }
}

/** What a panel of shaped votes decides: the tier by majority, and whether the premise and the reach held. @param {Vote[]} v */
export function votePanel(v) {
  const half = v.length / 2
  const lineOk = v.filter((/** @type {Vote} */ x) => x['citedLineMatches']).length >= Math.ceil(half)
  const reach = v.filter((/** @type {Vote} */ x) => x['reachable']).length >= Math.ceil(half)
  const premiseOk = v.filter((/** @type {Vote} */ x) => x['premiseSupported']).length >= Math.ceil(half)
  const refutes = v.filter((/** @type {Vote} */ x) => x['refuted']).length
  let tier
  if (!lineOk) tier = 'refuted'
  else if (refutes > half) tier = 'refuted'
  else if (refutes === 0) tier = 'confirmed'
  else tier = 'suspected'
  return { tier, premiseOk, reach }
}

/** A confirmed finding whose off-site premise no verifier pinned: Suspected. @param {Finding} f @returns {Finding} */
export function premiseDemoted(f) {
  return { ...f, tier: 'suspected', why: `${f['why']} (demoted to Suspected: the load-bearing premise is off-site and no verifier could pin it to real code${f['whereChecked'] ? ` — claimed at ${f['whereChecked']}` : ', and whereChecked was empty'})` }
}

/** A confirmed finding off every production-reachable path: one severity lower. @param {Finding} f @param {string} tier @returns {Finding} */
export function reachDemoted(f, tier) {
  const demoted = DEMOTE[f['severity'] ?? ''] || f['severity']
  // `demoted` is undefined only when `f` carries no severity, which `...f` already says.
  // The floor's note claims Medium; once demoted that is false, so it is dropped from the why.
  return { ...f, tier, ...(demoted === undefined ? {} : { severity: demoted }), why: `${withoutPathFloorNote(f['why'])} (severity demoted ${f['severity']}→${demoted}: not on a production-reachable path)` }
}

// Shared vote→tier decision, so the batched path cannot drift from the individual one.
//
// DISCARDING A VOTE IS ITSELF A DEGRADATION, AND IT MUST BE VISIBLE. Dropping an off-schema vote
// before the arithmetic is strictly better than reading its absent booleans as `false` (that deleted
// the finding outright — see the NINTH DOOR above), but as long as ONE shaped vote survived the
// discard was recorded nowhere: not on the finding, not in the counters, not in `notRun`. The shape
// that makes it matter is the opening pair: a Critical opens with one cheap cull plus the
// authoritative vote, `votesAgree` refuses an off-schema partner, and the escalation then buys
// `n1 - 1` further culls — which is ZERO at `verifyVotes: 1`. So the authoritative voice answering
// off-schema leaves the Critical decided by a single cheap vote, rendered exactly like a unanimous
// panel. The thinning is annotated on the finding (what a reader of the verdict sees) and counted in
// the run record as `verification.thinned` (what ranks across runs — a panel that keeps half-dying
// is fragility, and fragility is only legible as a repeat).
/** @param {Finding} f @param {Array<Vote | null | undefined>} votes @returns {Finding} */
export function tierFromVotes(f, votes) {
  const live = votes.filter(Boolean)
  // Off-schema votes are discarded BEFORE the arithmetic, not read as all-false (see isVerdictShaped).
  const v = live.filter(isVerdictShaped)
  const judged = decideTier(f, live, v)
  const discarded = live.length - v.length
  if (!discarded) return judged
  // THE MAXIMUM THINNING IS THE ONE THE COUNTER MUST NOT MISS. A panel whose EVERY returned vote was
  // off-schema is already routed to `unverified` by decideTier, whose `why` says exactly that — so
  // the clause below would be false twice over (no tier "stands on" anything, and the surviving
  // count is zero). But the discard is still the largest one there is, and dropping the flag here
  // made the counter read 0 for it: the flag is set, the sentence is not.
  if (judged['tier'] === 'unverified') return { ...judged, votesDiscarded: discarded }
  // ARITHMETIC, NOT A WORD FOR IT. The earlier phrasing said "a minority of the panel that answered"
  // unconditionally, which is false whenever the survivors are the larger half — at `verifyVotes: 3`
  // with one discard the verdict stands on 2 of 3. Only the share is named, and it is computed.
  const share = v.length * 2 < live.length ? 'a minority of' : v.length * 2 === live.length ? 'exactly half of' : 'most of'
  return {
    ...judged,
    votesDiscarded: discarded,
    why: `${judged['why']} (PANEL THINNED: ${discarded} of ${live.length} returned votes answered off-schema and were discarded before the arithmetic — this ${judged['tier']} stands on ${v.length} of ${live.length} returned votes, ${share} the panel that answered)`,
  }
}

// The round-local half of the clause above, for the ledger door. Like TRACKED_MARK, "this verdict
// stands on N of M votes" is a statement about the panel THIS round convened; carried into round N+1
// verbatim it describes a panel that never sat. Deliberately paren-free in its body so this stays a
// one-shot match.
export const THINNED_CLAUSE = / \(PANEL THINNED: [^)]*\)/g

/** @param {Finding[]} group @param {Profile} profile @param {string} [sources]  the run's EXTERNAL SOURCES block, as verifyPrompt takes it */
export function batchVerifyPrompt(group, profile, sources = '') {
  const pfs = group.map((f, i) => {
    const pf = promptFields(f)
    return render(verifyBatchFindingTpl, { index: String(i), ...findingFields(f, pf, sanitizeAttack(f['source']), '(none — claims to be self-contained at the cited line)') })
  }).join('\n')
  return render(verifyBatchTpl, {
    count: String(group.length), lang: profile.lang, sources, dependencySource: DEPENDENCY_SOURCE_HOW,
    harmQuestion: HARM_QUESTION, findings: pfs, last: String(group.length - 1),
  })
}
