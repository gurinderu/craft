// craft's SessionStart hook (hooks/hooks.json): reads the harness's JSON on stdin and prints the context
// lib/role-hook.mjs decides, or nothing. It never fails a session: any error is silence and exit 0
// (realm @nick/craft, #276).
import fs from 'node:fs'
import { sessionStartOutput } from './role-hook.mjs'
import { runIfMain } from './script-main.mjs'

/**
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} env
 * @param {() => string} [readInput] the hook's stdin; a test passes its own
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, env, readInput = () => fs.readFileSync(0, 'utf8')) {
  let out = ''
  try {
    let input = ''
    try { input = readInput() } catch { /* no stdin: the process cwd */ }
    out = sessionStartOutput(input, env, process.cwd())
  } catch { /* silence */ }
  return { exitCode: 0, stdout: out ? [out] : [], stderr: [] }
}

await runIfMain(import.meta.url, run)
