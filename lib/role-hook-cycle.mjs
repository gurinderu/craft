// The start hook's cycle lines per harness (lib/role-hook.mjs; realm @nick/craft, nodes #275, #293): Claude Code runs
// craft:develop and the review engines; Codex reads the skills (#292) and runs craft's review through the craft binary
// (craft:codex-review, #499), so a review there is run by the session itself.

/**
 * How Codex reviews: craft's review through the craft binary with its Codex backend (bin/craft, the craft:codex-review
 * skill; realm @nick/craft, node #499), run in the session, not a subagent; by hand, with a rubric where craft ships
 * one, when that command cannot run or fails: the route is not yet observed in a real Codex session.
 */
export const CODEX_REVIEW =
  "run craft:codex-review in this session, not in a subagent: read its SKILL.md and run the one command it gives (it drives craft's review through codex exec), then relay its verdict and findings; it is new and not yet observed in a real Codex session, so when that command cannot run here or fails, review the diff yourself: apply the checklist of craft:rust-review (Rust) or craft:nix-review (Nix), otherwise read the diff for defects, and report the findings by severity with file:line"

export const CYCLE = {
  'claude-code': [
    "craft: whichever declared role develops here runs its cycle with craft's tools: recall project memory (craft:memory) before the work; before a PR, the review loop to convergence and one full review (craft:develop).",
    "craft: only the main session can run craft's workflow engines (a session started with --agent counts if its tools allow Workflow); a role running as a subagent hands the review loop back to the main session.",
  ],
  codex: [
    "craft: whichever declared role develops here runs its cycle with craft's skills, reading each one's SKILL.md (its path is listed among your skills): recall project memory (craft:memory) before the work; before a PR, a review, its findings worked with craft:addressing-findings.",
    `craft: ${CODEX_REVIEW}.`,
  ],
}
