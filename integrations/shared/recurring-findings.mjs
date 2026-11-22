// Compatibility entry; recurrence selection and grouping live in craft runs recurring
// (realm @nick/craft, node #205). The package's version selects its binary.
import { nativeCommand } from './native-command.mjs'
import { runIfMain } from './script-main.mjs'

/**
 * Pass the original arguments and streams to the native reader, without a shell.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export function run(argv, env) {
  return nativeCommand('recurring-findings', ['runs', 'recurring', ...argv], env)
}

await runIfMain(import.meta.url, run)
