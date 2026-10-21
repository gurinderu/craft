// What the work hook says, per harness (realm @nick/craft, nodes #288, #293). Claude Code loads a skill with its
// Skill tool and runs craft's review engines with its Workflow tool; Codex has neither (#292): it reads a skill's
// SKILL.md from the path its skill list gives, and reviews in the session itself (lib/role-hook-cycle.mjs).
import { SWITCH_ENV } from './role-hook.mjs'
import { CODEX_REVIEW } from './role-hook-cycle.mjs'

export const OFF = `craft: the repo's own roles and rules still win; to silence this, set ${SWITCH_ENV}=0 or add \`craft-role-hook: off\` to AGENTS.md or CLAUDE.md.`
const MEMORY = 'craft:memory (record-decision, record-rule or record-question), and check the `memory backend:` line it prints'
const READ = 'SKILL.md (its path is listed among your skills)'

export const PROMPT_TEXT = [
  'craft: before your first tool call on this request, load its craft skill: review findings or PR comments → craft:addressing-findings (Skill tool); a review → the craft:review workflow for one pass, craft:develop (Skill tool) for the loop to a PR. Reading the PRs with gh first does not replace it.',
  `craft: record each finding you reject or defer with ${MEMORY}.`,
  'craft: delegating this to a subagent? Put these same instructions in its brief, and keep the review loop here in the main session: a subagent cannot run craft\'s workflow engines.',
  OFF,
].join('\n')
export const SUBAGENT_TEXT = [
  `craft: if your brief is to work review findings or PR comments: before your first tool call load craft:addressing-findings (Skill tool) and work them with it, and record each one you reject or defer with ${MEMORY}; if your brief is to review: report findings only, change no code and record nothing.`,
  'craft: a subagent cannot run craft\'s workflow engines (craft:review, craft:develop\'s loop): report back and leave the review loop to the main session.',
  OFF,
].join('\n')

export const CODEX_PROMPT_TEXT = [
  `craft: before your first tool call on this request, read its craft skill's ${READ}: review findings or PR comments → craft:addressing-findings; a review → ${CODEX_REVIEW}. Reading the PRs with gh first does not replace it.`,
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
