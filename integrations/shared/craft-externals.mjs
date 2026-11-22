// Compatibility entry for native discovery/import (realm @nick/craft, nodes #435, #573).
import { nativeCommand } from './native-command.mjs'
import { runIfMain } from './script-main.mjs'

/**
 * Preserve the helper's arguments, streams and exit code; the binary owns its contract.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export function run(argv, env) {
  return nativeCommand('craft-externals', ['__craft-externals', ...argv], env)
}

await runIfMain(import.meta.url, run)
