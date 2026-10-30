// craft's PreToolUse hook on the Agent tool (hooks/hooks.json): reads the harness's JSON on stdin, prints the context
// lib/reviewer-dispatch-hook.mjs decides when the repo's own reviewer is dispatched, or nothing, and appends its trace
// to ~/.craft/hooks.jsonl (lib/hook-log.mjs). It never blocks the dispatch and never fails a session: any error is
// silence and exit 0 (realm @nick/craft, #417, #276).
import fs from 'node:fs'
import os from 'node:os'
import { hookEntryRun } from './hook-entry-run.mjs'
import { reviewerDispatchHook } from './reviewer-dispatch-hook.mjs'
import { runIfMain } from './script-main.mjs'

/**
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} env
 * @param {() => string} [readInput] the hook's stdin; a test passes its own
 * @param {string} [home] where ~/.craft lives
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, env, readInput = () => fs.readFileSync(0, 'utf8'), home = os.homedir()) {
  return hookEntryRun(input => reviewerDispatchHook(input, env, process.cwd(), new Date()), readInput, home)
}

await runIfMain(import.meta.url, run)
