// craft's PreToolUse hook on Bash (hooks/hooks.json): reads the harness's JSON on stdin, prints the line
// lib/push-hook.mjs decides on a `git push`, or nothing, and appends its trace to ~/.craft/hooks.jsonl
// (lib/hook-log.mjs). It never blocks and never fails a session: any error is silence and exit 0, and each git call
// is cut off at GIT_TIMEOUT_MS (realm @nick/craft, #299, #276).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendHookLog, hookLogPath } from './hook-log.mjs'
import { pushHook } from './push-hook.mjs'
import { runIfMain } from './script-main.mjs'

const GIT_TIMEOUT_MS = 1500

/** @param {string[]} args @param {string} cwd @returns {string | null} */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0 ? r.stdout.trim() : null
}

/** The run store's index lines; a missing file or a torn line reads as none. @param {string} home */
function index(home) {
  /** @type {Array<Record<string, unknown>>} */
  const lines = []
  let text = ''
  try { text = fs.readFileSync(path.join(home, '.craft', 'runs', 'index.jsonl'), 'utf8') } catch { return lines }
  for (const line of text.split('\n')) {
    try {
      const v = /** @type {unknown} */ (JSON.parse(line))
      if (v !== null && typeof v === 'object') lines.push(/** @type {Record<string, unknown>} */ (v))
    } catch { /* a torn or blank line */ }
  }
  return lines
}

/**
 * @param {string[]} _argv @param {NodeJS.ProcessEnv} env
 * @param {() => string} [readInput] the hook's stdin; a test passes its own
 * @param {string} [home] where ~/.craft lives
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(_argv, env, readInput = () => fs.readFileSync(0, 'utf8'), home = os.homedir()) {
  let out = ''
  try {
    const { stdout, entry } = pushHook(readInput(), env, process.cwd(), new Date(), { git, index: () => index(home) })
    out = stdout
    if (entry) appendHookLog(entry, hookLogPath(home))
  } catch { /* silence */ }
  return { exitCode: 0, stdout: out ? [out] : [], stderr: [] }
}

await runIfMain(import.meta.url, run)
