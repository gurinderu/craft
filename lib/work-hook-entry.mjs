// craft's hook at the moment of work (hooks/hooks.json: UserPromptSubmit and SubagentStart): reads the harness's
// JSON on stdin, prints the context lib/work-hook.mjs decides, or nothing, and appends its trace to
// ~/.craft/hooks.jsonl (lib/hook-log.mjs). It never fails a session: any error is silence and exit 0
// (realm @nick/craft, #288, #276).
import fs from 'node:fs'
import os from 'node:os'
import { appendHookLog, hookLogPath, readHookLog } from './hook-log.mjs'
import { workHook } from './work-hook.mjs'
import { runIfMain } from './script-main.mjs'

/**
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} env
 * @param {() => string} [readInput] the hook's stdin; a test passes its own
 * @param {string} [home] where ~/.craft lives
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, env, readInput = () => fs.readFileSync(0, 'utf8'), home = os.homedir()) {
  let out = ''
  try {
    const file = hookLogPath(home)
    const { stdout, entry } = workHook(readInput(), env, process.cwd(), new Date(), () => readHookLog(file) ?? [])
    out = stdout
    if (entry) appendHookLog(entry, file)
  } catch { /* silence */ }
  return { exitCode: 0, stdout: out ? [out] : [], stderr: [] }
}

await runIfMain(import.meta.url, run)
