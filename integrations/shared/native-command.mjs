// Compatibility entries pass through to one binary implementation (realm @nick/craft, nodes #205, #573).
import { spawn } from 'node:child_process'
import os from 'node:os'
import { ensure, parseArgs } from './craft-bin.mjs'

/** @param {string} binary @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<number>} */
function forward(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1)))
  })
}

/**
 * Invoke the package-version binary with literal arguments and inherited streams.
 * @param {string} name @param {string[]} args @param {NodeJS.ProcessEnv} env
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function nativeCommand(name, args, env) {
  try {
    const binary = env['CRAFT_BIN'] || (await ensure({ ...parseArgs(['ensure'], env), token: env['GITHUB_TOKEN'] || env['GH_TOKEN'] || '' }))
    return { exitCode: await forward(binary, args, env), stdout: [], stderr: [] }
  } catch (error) {
    return { exitCode: 1, stdout: [], stderr: [`${name}: ${error instanceof Error ? error.message : String(error)}`] }
  }
}
