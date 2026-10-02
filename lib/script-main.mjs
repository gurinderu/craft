// The thin launch of a lib/ script (realm @nick/craft, #172): the script's work is its exported `run`, and
// its module body is one call here, which runs it only when the module is the command Node was given.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {{ exitCode: number, stdout: string[], stderr: string[] }} ScriptResult */

/**
 * When `moduleUrl` is the script Node was started with, run it on the command line and the environment,
 * print its lines and set the exit code; otherwise (the module was imported) do nothing.
 * @param {string} moduleUrl  the script's `import.meta.url`
 * @param {(argv: string[], env: NodeJS.ProcessEnv) => Promise<ScriptResult>} run
 * @returns {Promise<boolean>} whether it ran
 */
export async function runIfMain(moduleUrl, run) {
  const invoked = process.argv[1]
  if (!invoked || path.resolve(invoked) !== fileURLToPath(moduleUrl)) return false
  const r = await run(process.argv.slice(2), process.env)
  for (const line of r.stdout) console.log(line)
  for (const line of r.stderr) console.error(line)
  process.exitCode = r.exitCode
  return true
}
