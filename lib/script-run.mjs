// The shape of every `node lib/<name>.mjs` script (realm @nick/craft, node #172): all its work in an
// exported `run(argv, env)` that returns what it printed and its exit code, and a module body that only
// calls it when the file is the process's entry. A test then runs the parsing, the walk and the verdict
// in-process — where a mutation run can see them — instead of only through CI.
//
// Printing goes through `scriptOutput`: each chunk is recorded for the result and, when `env.echo` is
// set (the entry guard sets it), written to the real stream at once — so the bytes, their order across
// stdout and stderr, and whatever was printed before a crash are what the script always produced.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'

/** @typedef {'stdout' | 'stderr'} Stream */
/** @typedef {{ stream: Stream, text: string }} Chunk */
/** @typedef {{ output: Chunk[], exitCode: number }} ScriptResult */
/** @typedef {{ echo?: boolean }} ScriptEnv  what every script's `env` accepts; each adds its own seams */

/**
 * @param {ScriptEnv} [env]
 * @returns {{ out: (...args: unknown[]) => void, err: (...args: unknown[]) => void,
 *   write: (stream: Stream, text: string) => void, result: (exitCode: number) => ScriptResult }}
 */
export function scriptOutput(env = {}) {
  /** @type {Chunk[]} */
  const output = []
  /** @param {Stream} stream @param {string} text */
  const write = (stream, text) => {
    output.push({ stream, text })
    if (env.echo) process[stream].write(text)
  }
  return {
    // `format` is what console.log applies to its arguments, so a line reads as it did through console.
    out: (...args) => write('stdout', `${format(...args)}\n`),
    err: (...args) => write('stderr', `${format(...args)}\n`),
    write,
    result: exitCode => ({ output, exitCode }),
  }
}

/**
 * Whether the module at `metaUrl` is the script node was asked to run. By real path, not by URL text:
 * a checkout under a path with spaces or behind a symlink must still run.
 * @param {string} metaUrl  the caller's import.meta.url
 * @returns {boolean}
 */
export function invokedDirectly(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}

/**
 * Hands the script's exit code to the process; output was already written (echo). A rejected run is
 * left unhandled, so node reports it and exits non-zero as an uncaught throw always did.
 * @param {ScriptResult | Promise<ScriptResult>} result
 * @returns {void}
 */
export function exitWith(result) {
  if (result instanceof Promise) {
    void result.then(r => { process.exitCode = r.exitCode })
    return
  }
  process.exitCode = result.exitCode
}
