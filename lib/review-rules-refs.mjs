// Where a review agent reads craft's own skill files, and the prompt lines that send every lens and
// verifier to the language-independent review rules (skills/review-rules, realm @nick/craft, node #379).
// Lenses run as the reviewer agent, which has no Skill tool, so naming a skill reached nothing; a file
// is located the way the logger is (an explicit craftRoot, CLAUDE_PLUGIN_ROOT, the installed cache for
// this version — see loggerPrelude) and NEVER resolved against the reviewed repository, whose copy
// would be untrusted text steering the agent.
import { flattenField } from './prompt-fields.mjs'
import { render } from './content.mjs'
import reviewRulesTpl from '../content/prompts/review-rules.md'
import sharedExclusionsTpl from '../content/prompts/verify-shared-exclusions.md'

/** The skill directory every lens reads beside its language rubric. */
export const REVIEW_RULES_DIR = 'skills/review-rules'

/**
 * The places `file` (a path inside the plugin) may live, in the order an agent tries them, each in
 * backticks for the prompt.
 * @param {string} craftRoot  the run's craftRoot argument, model-composed
 * @param {string} craftVersion  the engine's release stamp
 * @param {string} file
 * @returns {string[]}
 */
export function pluginFileCandidates(craftRoot, craftVersion, file) {
  const root = flattenField(craftRoot)
  return [
    root ? `${root}/${file}` : '',
    `\${CLAUDE_PLUGIN_ROOT}/${file}`,
    `\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${craftVersion}/${file}`,
  ].filter(Boolean).map(c => `\`${c}\``)
}

/**
 * The REVIEW RULES line of a lens prompt: the shared severity, classes and sweeps, read beside the
 * rubric, with the harm rule stated inline as the fallback when no copy is readable.
 * @param {string} craftRoot @param {string} craftVersion
 */
export function reviewRulesLine(craftRoot, craftVersion) {
  return render(reviewRulesTpl, { dirs: pluginFileCandidates(craftRoot, craftVersion, REVIEW_RULES_DIR).join(', ') })
}

/**
 * The ALREADY-FOUND block of a lens prompt. It stops a lens re-reporting the SAME place and leaves
 * it free, indeed bound, to report the same class at a place the list does not cover.
 * @param {string} priorSummary
 */
export function alreadyFoundBlock(priorSummary) {
  return `ALREADY-FOUND (do not re-report these PLACES; the same class at a DIFFERENT place — error arm, record, hook, path, legacy cohort — is NOT a repeat: sibling sweep, sweeps.md §1):
${priorSummary}`
}

/**
 * The verifier's pointer to the language-independent exclusions (FP-002, KEEP-002, KEEP-004 and on),
 * shared by every profile; the profile's own exclusion file, when it has one, shares their ID space.
 * @param {string} craftRoot @param {string} craftVersion
 */
export function sharedExclusionsLine(craftRoot, craftVersion) {
  return `\n${render(sharedExclusionsTpl, { dirs: pluginFileCandidates(craftRoot, craftVersion, REVIEW_RULES_DIR).join(', ') })}\n`
}
