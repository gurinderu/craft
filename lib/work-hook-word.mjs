// Whose word a prompt is, in which script, and whether it is a bare "continue" (realm @nick/craft, node #288; the
// case it answers, #287): the prompt hook speaks only on a human's word, lets the model class a prompt in another
// script, and a continuation without a subject of its own carries the kind of the request it continues
// (recentKind, lib/work-hook-said.mjs).

// What Claude Code delivers as a user prompt that no human wrote: a subagent's hand-back ("Another Claude session
// sent a message:" then `<agent-message from="...">`), a message from another Claude session on the same machine (a
// bare `<cross-session-message from="uds:...">`, as observed in a consumer's queue, realm @nick/craft, node #289;
// the same preamble before it is the transcript's, not what the hook receives) and a background task's
// notification (a `<task-notification>` line). Either message tag counts at the prompt's start, bare or after the
// preamble; the preamble alone suffices too. A human quoting a tag inside a sentence is not caught: only the
// prompt's start, or the notification tag on a line of its own.
const HARNESS_WORDS = [
  /^\s*Another Claude session sent a message:/,
  /^\s*<(?:agent|cross-session)-message\b/,
  /^\s*<task-notification>\s*$/m,
]

/** Whether the prompt is the harness delivering an agent's words. @param {string} prompt @returns {boolean} */
export function notHuman(prompt) {
  return HARNESS_WORDS.some(re => re.test(prompt))
}

// A subagent's hand-back, by the shape above. Its `from` is the agent's id, not its type, so a reviewer's report
// looks like a fixer's. A message from another session is never a fixer's hand-back, so it is left out; so is a
// task notification: a background shell command ends with one too, and nothing in it is known to tell the two apart.
const HANDBACK = /^\s*(?:Another Claude session sent a message:\s*)?<agent-message\b/

/** Whether the prompt is a subagent's report. @param {string} prompt @returns {boolean} */
export function subagentReport(prompt) {
  return HANDBACK.test(prompt)
}

// A prompt in another script: at least MIN_OTHER letters outside the Latin script, and at least that share of all
// its letters. An English request quoting a foreign name stays English.
const MIN_OTHER = 3
const OTHER_SHARE = 0.3

/** Whether the prompt is mostly written in a script other than Latin. @param {string} prompt @returns {boolean} */
export function otherLanguage(prompt) {
  const letters = prompt.match(/\p{L}/gu)?.length ?? 0
  const other = prompt.match(/(?!\p{Script=Latin})\p{L}/gu)?.length ?? 0
  return other >= MIN_OTHER && other >= OTHER_SHARE * letters
}

// A continuation is a short English message made only of these words, with at least one verb among them; one in
// another script is otherLanguage's.
const VERB = /^(?:continue|continuing|proceed|resume|finish|keep|carry|go|wrap)$/
const REST = new Set([
  'it', 'the', 'this', 'that', 'work', 'job', 'up', 'on', 'going', 'ahead', 'where', 'you', 'we', 'left', 'off',
  'stopped', 'please', 'pls', 'plz', 'ok', 'okay', 'so', 'then', 'now', 'and', 'just', 'thanks', 'good', 'great',
])
const MAX_WORDS = 8

/** Whether the prompt is a bare continuation ("keep going", "finish it please"). @param {string} prompt @returns {boolean} */
export function continuation(prompt) {
  const words = prompt.toLowerCase().match(/[\p{L}']+/gu) ?? []
  if (words.length === 0 || words.length > MAX_WORDS) return false
  return words.some(w => VERB.test(w)) && words.every(w => VERB.test(w) || REST.has(w))
}
