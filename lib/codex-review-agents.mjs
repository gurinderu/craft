// What a task's model tokens mean in Codex (realm @nick/craft, nodes #465, #491): the Claude tiers, which Codex takes as
// the session's own model unless a table maps a tier to one, given as `-m`. The table's reading and the agents' prompt
// bodies are every process-per-task host's (lib/task-process-agents.mjs).
import { modelTable as hostModelTable } from './task-process-agents.mjs'

/** @typedef {import('./task-process-agents.mjs').ModelTable} ModelTable */

/** The model table from `codexModels=`'s text. @param {string} text */
export const modelTable = text => hostModelTable(text, 'codexModels', /^[\w.:/-]{1,80}$/)

/** The `-m` arguments for a tier: none when the table leaves it to the session. @param {ModelTable} table @param {string} tier @returns {string[]} */
export const modelArgs = (table, tier) => {
  const model = table.get(tier)
  return model ? ['-m', model] : []
}
