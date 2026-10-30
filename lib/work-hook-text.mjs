// What the work hook says, per harness and request kind (realm @nick/craft, nodes #288, #293). Claude Code loads a
// skill with its Skill tool and runs craft's review engines with its Workflow tool; Codex has neither (#292): it
// reads a skill's SKILL.md from the path its skill list gives, and reviews in the session itself
// (lib/role-hook-cycle.mjs). Subagents lack the memory tools: the launcher puts the recalled records into each
// brief. Triage is the main session's, never a subagent's: in Claude Code the craft:triage-findings workflow (the
// sift, the noise classes and the issue list live there), elsewhere the session's own sift; the main session records
// every disposition and files the issues, and subagents only fix the plan's file groups (skills/addressing-findings,
// "Who triages").
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_REVIEW } from './role-hook-cycle.mjs'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
const READ = 'SKILL.md (its path is listed among your skills)'
/** The main session holds the memory; `skill` names the memory skill, `record` how to record with it. @param {string} skill @param {string} record */
export const launcher = (skill, record) => `craft: subagents lack the memory tools, so you hold the memory: put the records ${skill} recalls, verbatim with their ids, into each brief, and record every triage disposition (each finding rejected or deferred) yourself, right after triage, never through a subagent, with ${record}.`
const LAUNCHER = launcher('craft:memory', MEMORY)
export const REPORT = 'report each planned fix you find wrong, with its reason, in your result; never re-triage and never write memory: your launcher decides and records it'
export const REVIEWER = 'report findings only, change no code and record nothing'
export const REVIEW_BRIEF = `"Review only: ${REVIEWER}; return each finding with its severity and file:line."`
/** Why addressing-findings beats working by hand; `subject` names it. @param {string} subject */
const whyFindings = subject => `craft: why: ${subject} checks each finding against the code for a verdict, keeps every rejection on record so later reviews know it, drafts each reply for its own thread, and re-reviews until green; that re-review loop stays with this main session even when subagents fix.`
export const WHY_FINDINGS = whyFindings('it')
/**
 * A subagent's findings line: triage is never its own; it fixes a plan's file group. `load` is how it loads
 * addressing-findings, `triager` who triages in this harness. @param {string} load @param {string} triager
 */
export const subagentWork = (load, triager) => `craft: if your brief is to work findings (triaging PR comments, drafting or posting replies to review threads and fixing per review comments all count): triage is never yours: ${triager}; a brief that asks you to triage: report that back and stop. For a file group of a triage plan: before your first tool call, ${load} and fix the group with it, its verdicts as given; replies are the main session's, posted only on the user's OK.`
export const SUBAGENT_MEMORY = `craft: you lack the memory tools and never write memory: the records your launcher recalled are in your brief; ${REPORT}.`
/** The brief a fixer gets with its file group; `load` names how it loads addressing-findings. @param {string} load */
export const fixBrief = load => `"Fix only: patch this file group of the triage plan, its verdicts as given; before your first tool call, load ${load} for how to fix and verify (its steps 5 and 6); ${REPORT}."`
/** The line that hands the fixes, and only them, to subagents. @param {string} brief @param {string} after */
export const delegateFixes = (brief, after) => `craft: delegating the fixes is fine: ${after}, paste this line verbatim into each fixer's brief with its file group: ${brief} Triage, memory writes, issues and the re-review stay here in the main session.`

// Each text gives one call to make first, one reason the skill beats doing it by hand, and lets delegation stand
// with a line to paste into the brief: a session told to work in subagents ignored a hook that told it to keep the
// work here (realm @nick/craft, #288). A review is never handed to a subagent as craft:develop, whose engines need
// the main session's Workflow tool; a delegated reviewer only reports.
const ADDRESS = 'Skill("craft:addressing-findings")'
const FINDINGS_BRIEF = fixBrief('the craft:addressing-findings skill (Skill tool)')
// The engine needs `pr` or a `report` file (src/triage-findings.js); a review report that lives only in the session
// is written to a file first.
const TRIAGE = 'triage the findings here in the main session, whatever their number: launch the craft:triage-findings workflow (Workflow tool) with report = the findings written to a file in the session\'s temporary directory whenever they live in a review report, and pr = the PR number whenever there is a PR (it reads the PR\'s threads itself), at least one of the two, and prBase = git merge-base origin/<trunk> <reviewed head> together with base = the reviewed head\'s SHA, only when the reviewed head is a branch diverging from trunk (that merge-base differs from the head; on trunk or with no branch leave prBase out, and the findings claimed not this PR\'s come to you), even when the recall above failed (it recalls for itself); never hand triage to a subagent, which has no Workflow tool; right after it returns, record each disposition and file its issues yourself'
// The two steps a session with the skill loaded still skipped (#288): the recall before triage (the skill's step 0)
// and the re-review after the fixes, before any reply is posted (its steps 7 and 8). That re-review is light: the fix
// commits only, from the commit the addressed review was made on (realm @nick/craft, node #12); a merge since: ask.
const LIGHT = 'a light re-review of the fix commits only (base: the commit the review was made on; a merge since it, as trunk merged in, means ask the human first)'
/** @param {string} recall how this harness calls the memory skill @param {string} [lead] when */
export const recallLine = (recall, lead = 'right after loading it') => `craft: ${lead}, before triage (its step 0): ${recall} recall(<finding keywords>, <path>) for every path the findings touch; a finding a recalled decision answers is triaged with it cited.`
/** @param {string} how the re-review in this harness */
export const reReviewLine = how => `craft: after the fixes are in (every fixer returned and pushed) and before posting any reply: run ${LIGHT}, ${how}, repeating until no Medium-or-higher finding is open (the whole diff only on the human's word); replies wait for it.`
// craft:review is the one engine named for any language: it routes the files outside its profiles itself (realm @nick/craft, node #420).
const ROUTES = 'on any language (it routes source files outside its Rust and Nix profiles to a nested adversarial review)'
const RE_REVIEW = `here in the main session with the craft:review workflow { base: <that commit>, fresh: true, fullEvery: 0 } ${ROUTES}`
const CODEX_RE_REVIEW = 'your own pass over git diff <that commit>..HEAD in this session'
/** A subagent reported back in a session that heard the findings text; it may not be the last fixer, or a fixer at all. @param {string | undefined} who */
export const nudgeText = who => `craft: if this report completes the fixes for the review findings, run ${LIGHT}, ${who === 'codex' ? CODEX_RE_REVIEW : RE_REVIEW}, before posting replies, until no Medium-or-higher finding is open.`
export const FINDINGS_TEXT = [
  `craft: before your first tool call on this request, make one call: ${ADDRESS}. Reading the PRs with gh first does not replace it.`,
  recallLine('Skill("craft:memory") and'),
  reReviewLine(RE_REVIEW),
  WHY_FINDINGS,
  LAUNCHER,
  `craft: ${TRIAGE}.`,
  delegateFixes(FINDINGS_BRIEF, 'once the triage workflow has returned and its dispositions are recorded'),
  OFF,
].join('\n')
export const REVIEW_TEXT = [
  `craft: before your first tool call on this request, make one call, here in the main session: Skill("craft:develop") for the review loop up to a PR; for one pass, the craft:review workflow ${ROUTES}. Never hand either to a subagent: it has no Workflow tool.`,
  'craft: why: craft:review runs the Rust or Nix gate and a fan-out of review lenses, then refutes and self-verifies each finding into one report with a verdict; the source files outside its profiles go to a nested adversarial review inside the same answer, which puts each finding to a verifier and adds a coverage critic; develop loops review → fix until no Medium-or-higher finding is open (at most 4 rounds, then it stops and tells you what is left), then one full review before the PR.',
  LAUNCHER,
  `craft: delegating a review to a reviewer agent is fine: paste this line verbatim into its brief: ${REVIEW_BRIEF} The fix loop stays here.`,
  OFF,
].join('\n')
// A prompt the hook cannot class (its words are in another script): the model classes it by these lines' own
// conditions, said once per context as a standing rule for the session; each later prompt in another script hears
// one reminder line instead (reminderLine). Neither covers a per-kind text, nor a per-kind text them (coveredBy).
/** The opening of the conditional text: what to do for each kind. @param {string} findings @param {string} review */
export const ifRequest = (findings, review) => `craft: if this or any later request in this session — in any language — asks to work review findings or PR comments (triage, replies, fixes), before your first tool call ${findings}; if it asks for a review, ${review}. These lines apply only to such requests.`
/** The reminder a later prompt in another script hears. @param {string} findings @param {string} review @param {string} how the re-review */
export const reminderLine = (findings, review, how) => `craft: if this request is about review findings, PR comments or a review, the craft lines above apply: ${findings} first for findings; ${review} for a review; recall memory before triage; before posting replies, run ${LIGHT}: ${how}.`
export const REMINDER_TEXT = reminderLine(ADDRESS, 'craft:develop or the review workflow', 'craft:review { base: <that commit>, fresh: true, fullEvery: 0 } on any language')
export const CODEX_REMINDER_TEXT = reminderLine(`read craft:addressing-findings' ${READ}`, 'review the diff in this session', 'your own review pass over them in this session')
/** The reminder line in a harness's words. @param {string | undefined} who */
export const reminderText = who => (who === 'codex' ? CODEX_REMINDER_TEXT : REMINDER_TEXT)
export const FOR_FINDINGS = 'for findings work, right after loading the skill'
/** Triage here, then delegation of either kind, in one line. @param {string} triage @param {string} brief */
export const delegateBoth = (triage, brief) => `craft: for findings, ${triage}; then only the fixes may be delegated: paste this line verbatim into each fixer's brief with its file group: ${brief} For a reviewer agent, paste: ${REVIEW_BRIEF} Triage, memory writes, issues and the re-review stay here.`
export const OTHER_LANGUAGE_TEXT = [
  ifRequest(`make one call: ${ADDRESS}`, `make one call here in the main session: Skill("craft:develop") for the review loop up to a PR, or for one pass the craft:review workflow ${ROUTES}; never hand either to a subagent`),
  recallLine('Skill("craft:memory") and', FOR_FINDINGS),
  reReviewLine(RE_REVIEW),
  LAUNCHER,
  delegateBoth(TRIAGE, FINDINGS_BRIEF),
  OFF,
].join('\n')

/**
 * The kinds whose text, once said in a context, makes the text for `kind` unneeded there: each text covers only
 * its own kind (a later prompt in another script hears the reminder, lib/work-hook-said.mjs); Codex's one English
 * text names both English kinds.
 * @param {string | undefined} who @param {import('./work-hook-kind.mjs').PromptKind} kind @returns {string[]}
 */
export function coveredBy(who, kind) {
  return who === 'codex' && kind !== 'other-language' ? ['findings', 'review'] : [kind]
}

export const SUBAGENT_TEXT = [
  subagentWork(`run ${ADDRESS}`, 'the main session runs the craft:triage-findings workflow, which you lack (no Workflow tool)'),
  SUBAGENT_MEMORY,
  `craft: if your brief is only to review: ${REVIEWER}.`,
  'craft: craft\'s workflow engines (Workflow tool: craft:review, craft:develop\'s loop) run only in the main session: report back and leave the review loop there.',
  OFF,
].join('\n')

export const CODEX_PROMPT_TEXT = [
  `craft: before your first tool call on this request, read its craft skill's ${READ}: review findings or PR comments → craft:addressing-findings; a review → ${CODEX_REVIEW}. Reading the PRs with gh first does not replace it.`,
  recallLine(`read craft:memory's ${READ} and`, 'for findings work, right after reading the skill'),
  reReviewLine(CODEX_RE_REVIEW),
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  `craft: triage the findings here in this session, never in a subagent, whatever their number: Codex has no triage engine, so do the sift steps of craft:addressing-findings ("Who triages") yourself, then record each disposition and file the issues; only the fixes may go to a subagent: brief it with its file group of the plan, the verdicts and the records craft:memory recalls, and tell it: "${REPORT[0]?.toUpperCase()}${REPORT.slice(1)}." Re-decide and record each one it reports. A review stays in this session.`,
  OFF,
].join('\n')
export const CODEX_OTHER_LANGUAGE_TEXT = [
  ifRequest(`read craft:addressing-findings' ${READ}`, CODEX_REVIEW),
  ...CODEX_PROMPT_TEXT.split('\n').slice(1),
].join('\n')
export const CODEX_SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: triage is never yours (the main session triages): fix only the file group your brief gives, its verdicts as given: before your first tool call read craft:addressing-findings' ${READ} for how to fix and verify, and ${REPORT}; if your brief is to review: ${REVIEWER}.`,
  OFF,
].join('\n')

/**
 * The prompt hook's text for a request kind and the subagent hook's text, for a harness. Codex's prompt text is the
 * same for both English kinds.
 * @param {string | undefined} who the harness (lib/hook-harness.mjs) @param {import('./work-hook-kind.mjs').PromptKind} [kind]
 * @returns {{ prompt: string, subagent: string }}
 */
export function workText(who, kind = 'findings') {
  const other = kind === 'other-language'
  if (who === 'codex') return { prompt: other ? CODEX_OTHER_LANGUAGE_TEXT : CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT }
  return { prompt: other ? OTHER_LANGUAGE_TEXT : kind === 'review' ? REVIEW_TEXT : FINDINGS_TEXT, subagent: SUBAGENT_TEXT }
}
