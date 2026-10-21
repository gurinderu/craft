// What the work hook says, per harness and request kind (realm @nick/craft, nodes #288, #293). Claude Code loads a
// skill with its Skill tool and runs craft's review engines with its Workflow tool; Codex has neither (#292): it
// reads a skill's SKILL.md from the path its skill list gives, and reviews in the session itself
// (lib/role-hook-cycle.mjs). Subagents lack the memory tools: the launcher puts the recalled records into each
// brief and records the verdicts a subagent reports (skills/memory, "Subagents"; skills/addressing-findings).
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_REVIEW } from './role-hook-cycle.mjs'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
const READ = 'SKILL.md (its path is listed among your skills)'
/** The main session holds the memory; `skill` names the memory skill, `record` how to record with it. @param {string} skill @param {string} record */
export const launcher = (skill, record) => `craft: subagents lack the memory tools, so you hold the memory: put the records ${skill} recalls, verbatim with their ids, into each brief, and record each finding you or a subagent reject or defer with ${record}.`
const LAUNCHER = launcher('craft:memory', MEMORY)
export const REPORT = 'report each finding you reject or defer, with its reason, in your result; your launcher records it'
export const REVIEWER = 'report findings only, change no code and record nothing'
export const REVIEW_BRIEF = `"Review only: ${REVIEWER}; return each finding with its severity and file:line."`
export const WHY_FINDINGS = 'craft: why: it checks each finding against the code for a verdict, keeps every rejection on record so later reviews know it, drafts each reply for its own thread, and re-reviews until green; that re-review loop stays with this main session even when subagents fix.'
/** A subagent's findings line; `load` is how it loads addressing-findings. @param {string} load */
export const subagentWork = load => `craft: if your brief is to work findings (triaging PR comments, drafting or posting replies to review threads and fixing per review comments all count): before your first tool call, ${load} and work them with it — it checks each against the code and drafts each reply for its own thread, posted only on the user's OK.`
export const SUBAGENT_MEMORY = `craft: you lack the memory tools: the records your launcher recalled are in your brief; ${REPORT}.`

// Each text gives one call to make first, one reason the skill beats doing it by hand, and lets delegation stand
// with a line to paste into the brief: a session told to work in subagents ignored a hook that told it to keep the
// work here (realm @nick/craft, #288). A review is never handed to a subagent as craft:develop, whose engines need
// the main session's Workflow tool; a delegated reviewer only reports.
const ADDRESS = 'Skill("craft:addressing-findings")'
const FINDINGS_BRIEF = `"Before your first tool call, load the craft:addressing-findings skill (Skill tool) and work the findings with it; ${REPORT}."`
export const FINDINGS_TEXT = [
  `craft: before your first tool call on this request, make one call: ${ADDRESS}. Reading the PRs with gh first does not replace it.`,
  WHY_FINDINGS,
  LAUNCHER,
  `craft: delegating is fine: load the skill here first, then paste this line verbatim into each subagent's brief: ${FINDINGS_BRIEF} Only craft's workflow engines (Workflow tool) must run here in the main session.`,
  OFF,
].join('\n')
export const REVIEW_TEXT = [
  'craft: before your first tool call on this request, make one call, here in the main session: Skill("craft:develop") for the review loop up to a PR (it picks the engine by the diff\'s languages); for one pass, the craft:review workflow on a Rust or Nix diff, the craft:adversarial-review workflow on any other. Never hand any of them to a subagent: it has no Workflow tool.',
  'craft: why: craft:review runs the Rust or Nix gate and a fan-out of review lenses, then refutes and self-verifies each finding into one report with a verdict; craft:adversarial-review fans review lenses out over any language, puts each finding to a verifier and adds a coverage critic; develop loops review → fix until no Medium-or-higher finding is open (at most 4 rounds, then it stops and tells you what is left), then one full review before the PR.',
  LAUNCHER,
  `craft: delegating a review to a reviewer agent is fine: paste this line verbatim into its brief: ${REVIEW_BRIEF} The fix loop stays here.`,
  OFF,
].join('\n')
export const SUBAGENT_TEXT = [
  subagentWork(`run ${ADDRESS}`),
  SUBAGENT_MEMORY,
  `craft: if your brief is only to review: ${REVIEWER}.`,
  'craft: craft\'s workflow engines (Workflow tool: craft:review, craft:develop\'s loop) run only in the main session: report back and leave the review loop there.',
  OFF,
].join('\n')

export const CODEX_PROMPT_TEXT = [
  `craft: before your first tool call on this request, read its craft skill's ${READ}: review findings or PR comments → craft:addressing-findings; a review → ${CODEX_REVIEW}. Reading the PRs with gh first does not replace it.`,
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  `craft: findings work may go to a subagent: brief it to read craft:addressing-findings' ${READ} and work the findings with it, give it the records craft:memory recalls, and tell it to ${REPORT}; record each one it reports. A review stays in this session.`,
  OFF,
].join('\n')
export const CODEX_SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: before your first tool call read craft:addressing-findings' ${READ} and work them with it, and ${REPORT}; if your brief is to review: ${REVIEWER}.`,
  OFF,
].join('\n')

/**
 * The prompt hook's text for a request kind and the subagent hook's text, for a harness. Codex's prompt text is the
 * same for both kinds.
 * @param {string | undefined} who the harness (lib/hook-harness.mjs) @param {'findings' | 'review'} [kind]
 * @returns {{ prompt: string, subagent: string }}
 */
export function workText(who, kind = 'findings') {
  if (who === 'codex') return { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT }
  return { prompt: kind === 'review' ? REVIEW_TEXT : FINDINGS_TEXT, subagent: SUBAGENT_TEXT }
}
