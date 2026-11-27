// The light review-task agent's system text on OpenCode 1.x (realm @nick/craft, node #707). The 1.x host calls one
// hook, `experimental.chat.system.transform` (node #294), on every request of a session — the session title's among
// them — and names no agent in its input; a request is the agent's when its system text opens with the first sentence
// of the agent's file (opencode 1.19.5). In such a request every rule file the host loaded is cut from every string of
// `system`, from the first line that begins as one to that string's end, and a string left empty leaves the array.
// Every other request passes as it came. The request's tools are not this hook's to change: what the agent is
// offered is closed by its file (node #691).
import { LOADED_RULES, isList } from './light-agent-shared.ts'

/** The first sentence of the agent's file (agents/review-task.md); a system text that opens with it is its session's. */
const OPENING = "You run exactly one task of craft's review, handed to you by the review driver."

/** A line that opens as a rule file the host loaded: `LOADED_RULES` has no character a pattern reads. */
const RULE_FILE_LINE = new RegExp(`^${LOADED_RULES}`, 'm')

/**
 * Lighten one request's `system` in place when it is the review-task agent's: every rule file the host loaded is cut
 * from each string, a string left empty is removed. Any other session's text passes as it came.
 */
export function lightenSystem(system: unknown): void {
  if (!isList(system) || typeof system[0] !== 'string' || !system[0].startsWith(OPENING)) return
  for (let i = system.length - 1; i >= 0; i--) {
    const text = system[i]
    if (typeof text !== 'string') continue
    const at = text.search(RULE_FILE_LINE)
    if (at < 0) continue
    if (at === 0) system.splice(i, 1)
    else system[i] = text.slice(0, at)
  }
}
