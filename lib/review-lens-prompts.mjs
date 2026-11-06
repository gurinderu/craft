// The review's per-profile prompts (src/review.js): the scout's, every lens's, the negative-space lens's and a
// consumer's extra lens's, each built from the run's options and the round's lens scope. Their text is in
// content/prompts/ (lib/content.mjs, realm @nick/craft, node #452); what is chosen or joined is chosen here and passed in.
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'
import { pathspecLiteral } from './lens-scope.mjs'
import { shq } from './run-logging.mjs'
import { flattenField } from './prompt-fields.mjs'
import { CONDITIONAL_LENSES } from './review-lens-tallies.mjs'
import { unitRuleBlock } from './review-unit-prompts.mjs'
import { alreadyFoundBlock, pluginFileCandidates, reviewRulesLine } from './review-rules-refs.mjs'
import { repoRulesLine, SCOUT_REPO_RULES_STEP } from './repo-rules.mjs'
import { render } from './content.mjs'
import scoutTpl from '../content/prompts/scout.md'
import scoutScopeTpl from '../content/prompts/scout-scope.md'
import lensTpl from '../content/prompts/lens.md'
import lensConfinedTpl from '../content/prompts/lens-confined.md'
import lensExtraTpl from '../content/prompts/lens-extra.md'
import lensNegativeSpaceTpl from '../content/prompts/lens-negative-space.md'
import lensNegativeSpaceSpecTpl from '../content/prompts/lens-negative-space-spec.md'
import lensSpecTpl from '../content/prompts/lens-spec.md'
import lensSliceTpl from '../content/prompts/lens-slice.md'
import lensStrictTpl from '../content/prompts/lens-strict-maintainability.md'
import lensReReviewRescanTpl from '../content/prompts/lens-re-review-rescan.md'
import lensReReviewFixesTpl from '../content/prompts/lens-re-review-fixes.md'
import lensMutantsTpl from '../content/prompts/lens-mutants.md'
import lensCatalogueTpl from '../content/prompts/lens-catalogue.md'

/**
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').PriorRoundAnswer} PriorRound
 * @typedef {import('./unit-scope.mjs').UnitGroup} Slice
 * @typedef {Parameters<typeof unitRuleBlock>[0]} Confinement  a dispatch's unit rule
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */

/**
 * The prompt builders of one run.
 * @param {ReviewRun} reviewRun @param {{ lensBase: string, priorRound: PriorRound | null, fullRescan: boolean }} scope  what the lenses diff against, and the round
 */
export function makeLensPrompts(reviewRun, { lensBase, priorRound, fullRescan }) {
const { craftVersion, intentArg, pathArg, craftRootArg, strict } = reviewRun
// ================= Prompt builders (profile-parameterized) =================
/** @param {Profile} profile */
function scoutPrompt(profile) {
  const globs = profile.diffGlobs.join(' ')
  return render(scoutTpl, {
    lang: profile.lang,
    scope: pathArg ? `\n\n${render(scoutScopeTpl, { dir: flattenField(pathArg), quoted: shq(pathArg) })}` : '',
    base: lensBaseLabel(),
    globs,
    statRange: lensBase ? `${shq(lensBase)}...HEAD` : 'HEAD',
    lenses: JSON.stringify(profile.lenses),
    safetyLens: profile.safetyLens,
    securityHints: profile.securityHints,
    conditionalLenses: JSON.stringify(profile.lenses.filter((/** @type {string} */ l) => CONDITIONAL_LENSES.includes(l))),
    scoutRules: profile.scoutRules,
    strict: strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : '',
    isLibrary: profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).',
    intent: intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.',
    repoRulesStep: SCOUT_REPO_RULES_STEP,
  })
}

/** @param {string} priorSummary @param {Profile} profile @param {Plan} plan */
function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  const nix = profile.lang === 'Nix'
  return render(lensNegativeSpaceTpl, {
    lang: profile.lang,
    navUse: profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use',
    base: lensBaseLabel(),
    intent: intent ? `INTENT (what the change should do): ${intent}` : '',
    spec: plan?.spec ? render(lensNegativeSpaceSpecTpl, { spec: plan.spec }) : '',
    range: lensDiffRange(),
    newSurface: nix ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field',
    shapeUses: nix ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes',
    rules: rulesLine(),
    repoRules: repoRulesLine(plan?.repoRules),
    alreadyFound: alreadyFoundBlock(priorSummary),
    rubricSkill: profile.rubricSkill,
  })
}

/** The diff base as the lens prompts name it. */
function lensBaseLabel() {
  return lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'
}

/** The `git diff` range argument the lens prompts hand the agent. */
function lensDiffRange() {
  return lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'
}

/** @param {Slice | null} slice @param {Profile} profile */
function lensPathspec(slice, profile) {
  return slice ? slice.files.map(pathspecLiteral).filter(Boolean).map(shq).join(' ') : profile.diffGlobs.join(' ')
}

/** @param {string} lens */
function strictMaintainabilityLine(lens) {
  return strict && lens === 'maintainability' ? `\n${render(lensStrictTpl)}\n` : ''
}

/** @param {Slice | null} slice */
function sliceBlock(slice) {
  return slice ? render(lensSliceTpl, { key: slice.key, count: String(slice.files.length) }) : ''
}

/** The re-review framing of a lens prompt, empty on a first round. */
function reReviewBlock() {
  if (!priorRound) return ''
  return render(fullRescan ? lensReReviewRescanTpl : lensReReviewFixesTpl, { base: flattenField(lensBase) })
}

/** @param {Plan} plan */
function lensPlanLines(plan) {
  return `${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? render(lensSpecTpl, { spec: plan.spec }) : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}
${repoRulesLine(plan.repoRules)}`
}

/** @param {Profile} profile @param {string} lens @param {Plan} plan */
function mutantsLine(profile, lens, plan) {
  return profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? render(lensMutantsTpl) : ''
}

// Where a lens reads its catalogue: located like every craft file a lens reads (lib/review-rules-refs.mjs),
// never in the reviewed repository. Built at use time for the same reason as loggerPreludeNow:
// craftVersion is declared below. Each entry names the classes its brief carries inline, which are the
// fallback when no candidate is readable.
/** @type {Record<string, { label: string, file: string, fallback: string }>} */
const LENS_CATALOGUES = {
  reconciler: { label: 'RACE CATALOGUE', file: 'skills/distributed-races/catalogue.md', fallback: 'R1–R6' },
  compat: { label: 'COMPATIBILITY CATALOGUE', file: 'skills/compatibility/catalogue.md', fallback: 'C1–C4, C8, C9 and C11–C13' },
}
/** @param {string} lens */
function lensCatalogueLine(lens) {
  const cat = Object.prototype.hasOwnProperty.call(LENS_CATALOGUES, lens) ? LENS_CATALOGUES[lens] : undefined
  if (!cat) return ''
  const candidates = pluginFileCandidates(craftRootArg, craftVersion, cat.file)
  return render(lensCatalogueTpl, { label: cat.label, candidates: candidates.join(', '), fallback: cat.fallback })
}

/** The external systems' sources a lens of EXTERNAL_LENSES reads (lib/review-external-sources.mjs), on a line of its own; '' otherwise. @param {string} lens */
function sourcesLine(lens) {
  const block = reviewRun.sources.lensBlock(lens)
  return block ? `\n${block}` : ''
}

/** The language-independent review rules every lens reads beside its rubric (realm @nick/craft, node #379). */
function rulesLine() {
  return reviewRulesLine(craftRootArg, craftVersion)
}

/**
 * What every judging lens prompt shares: who it is, its brief and catalogue, the rules, the diff and the round.
 * @param {string} lens @param {Profile} profile @param {Plan} plan
 */
function lensCommon(lens, profile, plan) {
  return {
    lens, lang: profile.lang, rubricSkill: profile.rubricSkill, brief: profile.lensBrief[lens] || lens,
    catalogue: lensCatalogueLine(lens), rules: rulesLine(), strict: strictMaintainabilityLine(lens),
    base: lensBaseLabel(), range: lensDiffRange(), reReview: reReviewBlock(), plan: lensPlanLines(plan),
    sources: sourcesLine(lens), mutants: mutantsLine(profile, lens, plan),
  }
}

/**
 * @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice | null} [slice]
 * @param {Confinement | null} [unit]  unitScope's confinement of this dispatch (realm @nick/craft, #316)
 */
function lensPrompt(lens, priorSummary, profile, plan, slice = null, unit = null) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  if (unit) return confinedLensPrompt(lens, priorSummary, profile, plan, /** @type {Slice} */ (slice), unit)
  // The pathspec the lens reviews. A slice replaces the profile's globs with its own files — that
  // is the entire mechanism: the agent pulls what it is responsible for instead of the whole diff,
  // and the per-turn re-read it pays for the rest of its life shrinks by the same factor.
  return render(lensTpl, {
    ...lensCommon(lens, profile, plan),
    navLoad: profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : '',
    pathspec: lensPathspec(slice, profile),
    slice: sliceBlock(slice),
    lsp: profile.navSkill ? ' + LSP' : '',
    dependencySource: DEPENDENCY_SOURCE_HOW,
    alreadyFound: alreadyFoundBlock(priorSummary),
  })
}

// A consumer's own agent run as an extra lens (realm @nick/craft, node #295): the whole change, no
// slice and no profile pathspec, answering in the finding schema every lens answers in.
/** @param {string} agentType @param {string} priorSummary @param {string[]} [repoRules]  the reviewed repository's rule files */
function extraLensPrompt(agentType, priorSummary, repoRules = []) {
  return render(lensExtraTpl, {
    agent: agentType,
    base: lensBaseLabel(),
    range: lensDiffRange(),
    pathspec: pathArg ? ` -- ${shq(pathArg)}` : '',
    reReview: reReviewBlock(),
    rules: rulesLine(),
    repoRules: repoRulesLine(repoRules),
    alreadyFound: alreadyFoundBlock(priorSummary),
  })
}
// A lens confined to one unit (unitScope): the same brief, with the unit rule in the place of the slice's
// "never what you may READ" and of the CONTEXT EXPANSION, BLAST-RADIUS and WHERE-CHECKED instructions, which
// send a lens into other units and contradict the rule (realm @nick/craft, #316).
/**
 * @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice} slice
 * @param {Confinement} unit
 */
function confinedLensPrompt(lens, priorSummary, profile, plan, slice, unit) {
  return render(lensConfinedTpl, {
    ...lensCommon(lens, profile, plan),
    pathspec: lensPathspec(slice, profile),
    key: slice.key,
    count: String(slice.files.length),
    noun: unit.kind.noun,
    unitRule: unitRuleBlock(unit),
    alreadyFound: alreadyFoundBlock(priorSummary),
  })
}
return { scoutPrompt, lensPrompt, extraLensPrompt, lensDiffRange }
}
