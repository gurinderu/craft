// The units CLI the review engine's Rust unit probe runs (realm @nick/craft, #377 under #375; the probe is
// #362's, its answer UNITS_SCHEMA): the Cargo packages of the repository in the working directory, each sized
// and with its dependencies, and the numstat of a diff range, printed as one JSON object. The probe stays an
// agent only because the Workflow sandbox cannot spawn a process (#134); the reshaping is here, the pure part
// in lib/cargo-units.mjs.
//
// Run: node lib/craft-units.mjs [--merge-base] <rev>...   (in the repository; the revisions as `git diff` takes
// them — the lens diff range, `--merge-base <base>` or `HEAD`, or a range like main...HEAD; no other option)
// Prints {"roots":[...],"packages":["@@ <dir> <.rs lines> <pub lines> <name> <deps>..."],"numstat":[...]}, exit 0;
// on a failure (no cargo, no Cargo.toml, a command's non-zero exit, a bad argument) {"roots":[],"error":"..."},
// exit 1 — `roots` is kept so the answer still fits UNITS_SCHEMA, which requires it.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runIfMain } from './script-main.mjs'
import { cargoPackages, countLines, parseGrepCounts, parseLsFiles, unitsAnswer } from './cargo-units.mjs'

// The prose probe's pattern for a public line (lib/rust-units.mjs), as git grep's extended regex.
const PUB_LINE = '^[[:space:]]*pub[[:space:](]'
const MAX_BUFFER = 512 * 1024 * 1024

/** @typedef {(cmd: string, args: string[]) => string} Exec  runs a command in the working directory, its stdout; throws on a non-zero exit */

/** @type {Exec} */
const execInCwd = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })

/** Why a command failed, in one line: its stderr's first line, else the error's message. @param {string} what @param {unknown} e */
function failure(what, e) {
  const err = /** @type {{ code?: unknown, stderr?: unknown, message?: unknown }} */ (e ?? {})
  if (err.code === 'ENOENT') return `${what}: not found on PATH`
  const said = String(err.stderr ?? '').split('\n').map(l => l.trim()).find(Boolean)
  return `${what} failed: ${said || String(err.message ?? e)}`.slice(0, 300)
}

/** The real path, or the path as given when it cannot be resolved. @param {string} p */
function real(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

/**
 * Why `revs` are not a diff range the CLI takes, '' when they are: `--merge-base` and revisions only, so no
 * other `git diff` option (an `--output=<file>` above all) can ride in on a model-composed base.
 * @param {string[]} revs
 */
export function badRange(revs) {
  if (!revs.some(r => r !== '--merge-base')) return 'no revision given'
  const opt = revs.find(r => r !== '--merge-base' && (!r || r.startsWith('-')))
  return opt == null ? '' : `not a revision: ${JSON.stringify(opt)}`
}

/**
 * A command runner whose failure is an Error saying what failed; `empty` names a non-zero exit that is an
 * empty answer rather than a failure.
 * @param {Exec} exec
 */
function runner(exec) {
  /** @param {string} what @param {string} cmd @param {string[]} args @param {(e: unknown) => boolean} [empty] */
  return (what, cmd, args, empty) => {
    try { return exec(cmd, args) } catch (e) {
      if (empty?.(e)) return ''
      throw new Error(failure(what, e))
    }
  }
}

/** git grep exits 1 when nothing matches: no public line anywhere, not a failure. @param {unknown} e */
const noMatch = e => /** @type {{ status?: unknown }} */ (e ?? {}).status === 1

/**
 * cargo metadata's JSON, each manifest path by its directory's real path, so it compares with git's toplevel
 * (also real) when the repository is reached through a symlink.
 * @param {string} text @returns {unknown}
 */
function metadataOf(text) {
  /** @type {{ packages?: Array<{ manifest_path?: unknown }> } | null} */
  let meta
  try { meta = JSON.parse(text) } catch { throw new Error('cargo metadata printed no JSON') }
  for (const p of Array.isArray(meta?.packages) ? meta.packages : []) {
    if (p?.manifest_path) p.manifest_path = path.join(real(path.dirname(String(p.manifest_path))), 'Cargo.toml')
  }
  return meta
}

/**
 * The lines of each tracked `.rs` file; one that cannot be read (a submodule, a dangling link) has none.
 * @param {string[]} files @param {string} top @param {(file: string) => string} readFile
 */
function rsLinesOf(files, top, readFile) {
  /** @type {Map<string, number>} */
  const out = new Map()
  for (const f of files.filter(x => x.endsWith('.rs'))) {
    try { out.set(f, countLines(readFile(path.join(top, f)))) } catch { /* no lines */ }
  }
  return out
}

/**
 * The answer for the diff range `revs` in the working directory, or `{ roots: [], error }`.
 * @param {string[]} revs  `git diff`'s revision arguments
 * @param {{ exec?: Exec, readFile?: (file: string) => string }} [io]  injected by tests
 * @returns {{ roots: string[], packages?: string[], numstat?: string[], error?: string }}
 */
export function collectUnits(revs, { exec = execInCwd, readFile = f => fs.readFileSync(f, 'utf8') } = {}) {
  const bad = badRange(revs)
  if (bad) return { roots: [], error: `usage: craft-units [--merge-base] <rev>... — ${bad}` }
  const run = runner(exec)
  try {
    const top = real(run('git rev-parse', 'git', ['rev-parse', '--show-toplevel']).trim())
    const packages = cargoPackages(metadataOf(run('cargo metadata', 'cargo', ['metadata', '--format-version', '1', '--no-deps'])), top)
    const files = parseLsFiles(run('git ls-files', 'git', ['-C', top, 'ls-files', '-z']))
    const pubLines = parseGrepCounts(run('git grep', 'git', ['-C', top, 'grep', '-I', '-c', '-z', '-E', PUB_LINE], noMatch))
    const numstat = run('git diff', 'git', ['diff', '--numstat', '--no-renames', ...revs, '--'])
    return unitsAnswer(packages, rsLinesOf(files, top, readFile), pubLines, numstat)
  } catch (e) {
    return { roots: [], error: e instanceof Error ? e.message : String(e) }
  }
}

/** @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>} */
export async function run(argv) {
  const answer = collectUnits(argv.map(String))
  return { exitCode: answer.error ? 1 : 0, stdout: [JSON.stringify(answer)], stderr: [] }
}

await runIfMain(import.meta.url, run)
