// What the work hook says, per harness (realm @nick/craft, nodes #288, #293). Claude Code loads a skill with its
// Skill tool and runs craft's review engines with its Workflow tool; Codex has neither (#292): it reads a skill's
// SKILL.md from the path its skill list gives, and reviews with the skill's guidance alone.
import { SWITCH_ENV } from './role-hook.mjs'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
const READ = 'SKILL.md (its path is listed among your skills)'

// Each text gives one call to make first, one reason the skill beats doing it by hand, and lets delegation stand: a
// session told to work in subagents ignored a hook that told it to keep the work here (realm @nick/craft, #288).
const ADDRESS = 'Skill("craft:addressing-findings")'
const BRIEF = '"Before your first tool call, load the craft:addressing-findings skill (Skill tool) and work the findings with it; record each one you reject or defer with craft:memory."'
export const PROMPT_TEXT = [
  `craft: before your first tool call on this request, make one call: review findings or PR comments → ${ADDRESS}; a review → Skill("craft:develop") for the loop to a PR, or the craft:review workflow for one pass. Reading the PRs with gh first does not replace it.`,
  'craft: why: addressing-findings checks each finding against the code for a verdict, records every rejection so later reviews know it, drafts each reply for its own thread, and re-reviews until green; develop loops review → fix until no Medium-or-higher finding is open, then opens the PR.',
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  `craft: delegating is fine: load the skill here first, then paste this line verbatim into each subagent's brief: ${BRIEF} Only craft's workflow engines (Workflow tool) must run here in the main session.`,
  OFF,
].join('\n')
export const SUBAGENT_TEXT = [
  `craft: if your brief is to work findings (triaging PR comments, drafting or posting replies to review threads and fixing per review comments all count): before your first tool call, run ${ADDRESS} and work them with it — it checks each against the code, records each rejection, and drafts each reply for its own thread, posted only on the user's OK. Record each one you reject or defer with ${MEMORY}.`,
  'craft: if your brief is only to review: report findings only, change no code and record nothing.',
  'craft: craft\'s workflow engines (Workflow tool: craft:review, craft:develop\'s loop) run only in the main session: report back and leave the review loop there.',
  OFF,
].join('\n')

export const CODEX_PROMPT_TEXT = [
  `craft: before your first tool call on this request, read its craft skill's ${READ}: review findings or PR comments → craft:addressing-findings; a review → craft's review engines need Claude Code and are not available here, so review with the guidance of craft:rust-review or craft:nix-review and report the findings. Reading the PRs with gh first does not replace it.`,
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  'craft: delegating this to a subagent? Put these same instructions in its brief.',
  OFF,
].join('\n')
export const CODEX_SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: before your first tool call read craft:addressing-findings' ${READ} and work them with it, and record each one you reject or defer with ${MEMORY}; if your brief is to review: report findings only, change no code and record nothing.`,
  OFF,
].join('\n')

/**
 * The prompt hook's and the subagent hook's text for a harness.
 * @param {string | undefined} who the harness (lib/hook-harness.mjs) @returns {{ prompt: string, subagent: string }}
 */
export function workText(who) {
  return who === 'codex' ? { prompt: CODEX_PROMPT_TEXT, subagent: CODEX_SUBAGENT_TEXT } : { prompt: PROMPT_TEXT, subagent: SUBAGENT_TEXT }
}
