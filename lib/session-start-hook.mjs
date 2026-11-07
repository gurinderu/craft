// craft's SessionStart hook (hooks/hooks.json): reads the harness's JSON on stdin, prints the context
// lib/role-hook.mjs decides, or nothing, and appends its trace to ~/.craft/hooks.jsonl (lib/hook-log.mjs). It
// never fails a session: any error is silence and exit 0 (realm @nick/craft, #276, #281).
import fs from 'node:fs'
import os from 'node:os'
import { appendHookLog, hookLogPath } from './hook-log.mjs'
import { sessionStart } from './role-hook.mjs'
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
    let input = ''
    try { input = readInput() } catch { /* no stdin: the process cwd */ }
    const { stdout, entry } = sessionStart(input, env, process.cwd(), new Date())
    out = stdout
    appendHookLog(entry, hookLogPath(home))
  } catch { /* silence */ }
  return { exitCode: 0, stdout: out ? [out] : [], stderr: [] }
}

await runIfMain(import.meta.url, run)
