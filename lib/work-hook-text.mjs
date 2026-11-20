// The phrases of the OpenCode work hook's texts (lib/work-hook-opencode.mjs; realm @nick/craft, nodes #288, #293); the
// Claude Code and Codex texts, built from the same phrases, are the craft binary's (cli/bin/craft/src/hook/role/text.rs,
// #538). Subagents lack the memory tools: the launcher puts the recalled records into each brief. Triage is the main
// session's, never a subagent's: the session records every disposition and files the issues, and subagents only fix
// the plan's file groups (skills/addressing-findings, "Who triages").
import { SWITCH_ENV } from './role-hook.mjs'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
/** The main session holds the memory; `skill` names the memory skill, `record` how to record with it. @param {string} skill @param {string} record */
export const launcher = (skill, record) =>
  `craft: subagents lack the memory tools, so you hold the memory: put the records ${skill} recalls, verbatim with their ids, into each brief, and record every triage disposition (each finding rejected or deferred) yourself, right after triage, never through a subagent, with ${record}.`
export const REPORT =
  'report each planned fix you find wrong, with its reason, in your result; never re-triage and never write memory: your launcher decides and records it'
export const REVIEWER = 'report findings only, change no code and record nothing'
export const REVIEW_BRIEF = `"Review only: ${REVIEWER}; return each finding with its severity and file:line."`
/** Why addressing-findings beats working by hand; `subject` names it. @param {string} subject */
const whyFindings = subject =>
  `craft: why: ${subject} checks each finding against the code for a verdict, keeps every rejection on record so later reviews know it, drafts each reply for its own thread, and re-reviews until green; that re-review loop stays with this main session even when subagents fix.`
export const WHY_FINDINGS = whyFindings('it')
/**
 * A subagent's findings line: triage is never its own; it fixes a plan's file group. `load` is how it loads
 * addressing-findings, `triager` who triages in this harness. @param {string} load @param {string} triager
 */
export const subagentWork = (load, triager) =>
  `craft: if your brief is to work findings (triaging PR comments, drafting or posting replies to review threads and fixing per review comments all count): triage is never yours: ${triager}; a brief that asks you to triage: report that back and stop. For a file group of a triage plan: before your first tool call, ${load} and fix the group with it, its verdicts as given; replies are the main session's, posted only on the user's OK.`
export const SUBAGENT_MEMORY = `craft: you lack the memory tools and never write memory: the records your launcher recalled are in your brief; ${REPORT}.`
/** The brief a fixer gets with its file group; `load` names how it loads addressing-findings. @param {string} load */
export const fixBrief = load =>
  `"Fix only: patch this file group of the triage plan, its verdicts as given; before your first tool call, load ${load} for how to fix and verify (its steps 5 and 6); ${REPORT}."`
/** The line that hands the fixes, and only them, to subagents. @param {string} brief @param {string} after */
export const delegateFixes = (brief, after) =>
  `craft: delegating the fixes is fine: ${after}, paste this line verbatim into each fixer's brief with its file group: ${brief} Triage, memory writes, issues and the re-review stay here in the main session.`

// The two steps a session with the skill loaded still skipped (#288): the recall before triage (the skill's step 0)
// and the re-review after the fixes, before any reply is posted (its steps 7 and 8). That re-review is light: the fix
// commits only, from the commit the addressed review was made on (realm @nick/craft, node #12); a merge since: ask.
const LIGHT =
  'a light re-review of the fix commits only (base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first)'
/** @param {string} recall how this harness calls the memory skill @param {string} [lead] when */
export const recallLine = (recall, lead = 'right after loading it') =>
  `craft: ${lead}, before triage (its step 0): ${recall} recall(<finding keywords>, <path>) for every path the findings touch; a finding a recalled decision answers is triaged with it cited.`
/** @param {string} how the re-review in this harness */
export const reReviewLine = how =>
  `craft: after the fixes are in (every fixer returned and pushed) and before posting any reply: run ${LIGHT}, ${how}, repeating until no Medium-or-higher finding is open (the whole diff only on the human's word); replies wait for it.`
// A prompt the hook cannot class (its words are in another script): the model classes it by these lines' own
// conditions, said once per context as a standing rule for the session; each later prompt in another script hears
// one reminder line instead (reminderLine). Neither covers a per-kind text, nor a per-kind text them (coveredBy).
/** The opening of the conditional text: what to do for each kind. @param {string} findings @param {string} review */
export const ifRequest = (findings, review) =>
  `craft: if this or any later request in this session — in any language — asks to work review findings or PR comments (triage, replies, fixes), before your first tool call ${findings}; if it asks for a review, ${review}. These lines apply only to such requests.`
/** The reminder a later prompt in another script hears. @param {string} findings @param {string} review @param {string} how the re-review */
export const reminderLine = (findings, review, how) =>
  `craft: if this request is about review findings, PR comments or a review, the craft lines above apply: ${findings} first for findings; ${review} for a review; recall memory before triage; before posting replies, run ${LIGHT}: ${how}.`
export const FOR_FINDINGS = 'for findings work, right after loading the skill'
/** Triage here, then delegation of either kind, in one line. @param {string} triage @param {string} brief */
export const delegateBoth = (triage, brief) =>
  `craft: for findings, ${triage}; then only the fixes may be delegated: paste this line verbatim into each fixer's brief with its file group: ${brief} For a reviewer agent, paste: ${REVIEW_BRIEF} Triage, memory writes, issues and the re-review stay here.`

/**
 * The kinds whose text, once said in a context, makes the text for `kind` unneeded there: each text covers only
 * its own kind (a later prompt in another script hears the reminder, lib/work-hook-said.mjs); Codex's one English
 * text names both English kinds.
 * @param {string | undefined} who @param {import('./work-hook-kind.mjs').PromptKind} kind @returns {string[]}
 */
export function coveredBy(who, kind) {
  return who === 'codex' && kind !== 'other-language' ? ['findings', 'review'] : [kind]
}
