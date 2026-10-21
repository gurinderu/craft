// Which harness runs craft's hook: the same hooks/hooks.json and lib/ serve Claude Code and Codex CLI (realm
// @nick/craft, node #293; the Codex surface, #292). Codex puts `turn_id` in its UserPromptSubmit and SubagentStart
// inputs and gives a hook command `PLUGIN_ROOT` beside `CLAUDE_PLUGIN_ROOT`; Claude Code does neither. Claude Code's
// SessionStart carries `model` too, so `model` does not tell them apart.

/** @typedef {'codex' | 'claude-code'} Harness */

/**
 * @param {Record<string, unknown>} input the hook's parsed stdin @param {Record<string, string | undefined>} env
 * @returns {Harness}
 */
export function harness(input, env) {
  if (typeof input['turn_id'] === 'string' && input['turn_id'] !== '') return 'codex'
  return env['PLUGIN_ROOT'] ? 'codex' : 'claude-code'
}
