// The body a hook entry shares (lib/push-hook-entry.mjs, lib/reviewer-dispatch-hook-entry.mjs): decide on the
// harness's stdin, append the decision's trace to ~/.craft/hooks.jsonl (lib/hook-log.mjs), print what it says. It
// never fails a session: any error is silence and exit 0 (realm @nick/craft, #276).
import { appendHookLog, hookLogPath } from './hook-log.mjs'

/**
 * @param {(input: string) => { stdout: string, entry: import('./hook-log.mjs').HookEntry | null }} decide
 * @param {() => string} readInput @param {string} home where ~/.craft lives
 * @returns {import('./script-main.mjs').ScriptResult}
 */
export function hookEntryRun(decide, readInput, home) {
  let out = ''
  try {
    const { stdout, entry } = decide(readInput())
    out = stdout
    if (entry) appendHookLog(entry, hookLogPath(home))
  } catch { /* silence */ }
  return { exitCode: 0, stdout: out ? [out] : [], stderr: [] }
}
