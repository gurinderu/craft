// Compatibility entry; recurrence selection and grouping live in craft runs recurring
// (realm @nick/craft, node #205). The package's version selects its binary.
import { spawn } from 'node:child_process'
import os from 'node:os'
import { ensure, parseArgs } from './craft-bin.mjs'
import { runIfMain } from './script-main.mjs'

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
function forward(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['runs', 'recurring', ...args], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1)))
  })
}

/**
 * Pass the original arguments and streams to the native reader, without a shell.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, env) {
  try {
    const binary = env['CRAFT_BIN'] || (await ensure(parseArgs(['ensure'], env)))
    const exitCode = await forward(binary, argv, env)
    return { exitCode, stdout: [], stderr: [] }
  } catch (error) {
    return { exitCode: 1, stdout: [], stderr: [`recurring-findings: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

await runIfMain(import.meta.url, run)
