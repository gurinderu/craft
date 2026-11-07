// The start hook's cycle lines per harness (lib/role-hook.mjs; realm @nick/craft, nodes #275, #293): Claude Code runs
// craft:develop and the review engines; Codex reads the skills (#292) and has neither craft's review agents nor its
// engines, so a review there is the session's own.

/** How Codex reviews: in the session, not a subagent, with a rubric where craft ships one, findings by severity with file:line. */
export const CODEX_REVIEW = 'craft ships no review agents or engines to Codex, so review the diff in this session yourself, not in a subagent: apply the checklist of craft:rust-review (Rust) or craft:nix-review (Nix), otherwise read the diff for defects, and report the findings by severity with file:line'

export const CYCLE = {
  'claude-code': [
    'craft: whichever declared role develops here runs its cycle with craft\'s tools: recall project memory (craft:memory) before the work; before a PR, the review loop to convergence and one full review (craft:develop).',
    'craft: only the main session can run craft\'s workflow engines (a session started with --agent counts if its tools allow Workflow); a role running as a subagent hands the review loop back to the main session.',
  ],
  codex: [
    'craft: whichever declared role develops here runs its cycle with craft\'s skills, reading each one\'s SKILL.md (its path is listed among your skills): recall project memory (craft:memory) before the work; before a PR, a review, its findings worked with craft:addressing-findings.',
    `craft: ${CODEX_REVIEW}.`,
  ],
}
