// The thin launch of a lib/ script (realm @nick/craft, #172): the script's work is its exported `run`, and
// its module body is one call here, which runs it only when the module is the command Node was given.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {{ exitCode: number, stdout: string[], stderr: string[] }} ScriptResult */

// Arrays whose lines were written the moment they were pushed, so `runIfMain` does not print them again.
/** @type {WeakSet<string[]>} */
const ECHOED = new WeakSet()
// Set while `runIfMain` runs a script: its lines go out as they arise, so a stream read as one (`2>&1`) has
// them in the order they were said, and a throw the script does not catch keeps what was already said.
let launched = false

/**
 * An array that writes each line pushed into it to `write` at once, and keeps it. Only `push` echoes: an array
 * derived from it (`map`, `slice`) is a plain one.
 * @param {(line: string) => void} write @returns {string[]}
 */
function echoing(write) {
  /** @type {string[]} */
  const lines = []
  lines.push = (...more) => {
    for (const line of more) write(line)
    return Array.prototype.push.apply(lines, more)
  }
  ECHOED.add(lines)
  return lines
}

/** A warning sink for a library caller that passed none: each warning reaches stderr as it arises. @returns {string[]} */
export function stderrLines() {
  return echoing(line => console.error(line))
}

/**
 * Where a script's `run` collects what it says: written through as it is pushed when `runIfMain` launched it,
 * plain arrays when `run` is called in-process (a test reads them from the result).
 * @returns {{ stdout: string[], stderr: string[] }}
 */
export function outputLines() {
  if (!launched) return { stdout: [], stderr: [] }
  return { stdout: echoing(line => console.log(line)), stderr: stderrLines() }
}

/**
 * By real path, not by the text typed: Node resolves the main module's symlinks but leaves `argv[1]` as given,
 * so a checkout reached through a symlink must compare equal. A path that does not exist is only resolved.
 * @param {string} p @returns {string}
 */
export function realOrResolved(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** @param {string[]} lines @param {(line: string) => void} write */
function printUnechoed(lines, write) {
  if (!ECHOED.has(lines)) for (const line of lines) write(line)
}

/**
 * When `moduleUrl` is the script Node was started with, run it on the command line and the environment,
 * print its lines and set the exit code; otherwise (the module was imported) do nothing. Lines collected in
 * `outputLines()` were printed as they arose; any other returned array is printed after `run` settles.
 * @param {string} moduleUrl  the script's `import.meta.url`
 * @param {(argv: string[], env: NodeJS.ProcessEnv) => Promise<ScriptResult>} run
 * @returns {Promise<boolean>} whether it ran
 */
export async function runIfMain(moduleUrl, run) {
  const invoked = process.argv[1]
  if (!invoked || realOrResolved(invoked) !== realOrResolved(fileURLToPath(moduleUrl))) return false
  launched = true
  /** @type {ScriptResult} */
  let r
  try { r = await run(process.argv.slice(2), process.env) } finally { launched = false }
  printUnechoed(r.stdout, line => console.log(line))
  printUnechoed(r.stderr, line => console.error(line))
  process.exitCode = r.exitCode
  return true
}
