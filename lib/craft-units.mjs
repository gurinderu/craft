// The units CLI the review engine's Rust unit probe runs (realm @nick/craft, #377 under #375; the probe is
// #362's, its answer UNITS_SCHEMA): the prose probe's commands (lib/rust-units.mjs) run as Node, so its answer
// is theirs by construction — every tracked `Cargo.toml` with a `[package]` line, sized by the `.rs` lines and
// the `pub` lines git lists under its directory, with its name and dependencies as the awk read them — and the
// numstat of a diff range, printed as one JSON object. No cargo is needed. The probe stays an agent only
// because the Workflow sandbox cannot spawn a process (#134); the pure part is lib/cargo-units.mjs.
//
// Run: node lib/craft-units.mjs [--merge-base] <rev>...   (in the repository; the revisions as `git diff` takes
// them — the lens diff range, `--merge-base <base>` or `HEAD`, or a range like main...HEAD; no other option)
// Prints {"roots":[...],"packages":["@@ <dir> <.rs lines> <pub lines> <name> <deps>..."],"numstat":[...]}, exit 0;
// on a failure (not a git repository, a failed git command, a bad argument) {"roots":[],"error":"..."}, exit 1 —
// `roots` is kept so the answer still fits UNITS_SCHEMA, which requires it. Paths are the working directory's,
// as the prose commands ran there.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runIfMain } from './script-main.mjs'
import { countLines, dirnameOf, hasPackageSection, manifestLine, readLines, rsPaths, unitsAnswer } from './cargo-units.mjs'

// The prose probe's pattern for a public line (lib/rust-units.mjs), as git grep's extended regex.
const PUB_LINE = '^[[:space:]]*pub[[:space:](]'
const MAX_BUFFER = 512 * 1024 * 1024

/** @typedef {(cmd: string, args: string[]) => string} Exec  runs a command in the working directory, its stdout; throws on a non-zero exit */

/** @param {string | undefined} cwd @returns {Exec} */
const execIn = cwd => (cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })

/** Why a command failed, in one line: its stderr's first line, else the error's message. @param {string} what @param {unknown} e */
function failure(what, e) {
  const err = /** @type {{ code?: unknown, stderr?: unknown, message?: unknown }} */ (e ?? {})
  if (err.code === 'ENOENT') return `${what}: not found on PATH`
  const said = String(err.stderr ?? '').split('\n').map(l => l.trim()).find(Boolean)
  return `${what} failed: ${said || String(err.message ?? e)}`.slice(0, 300)
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

/** A file's text; one that cannot be read (quoted by git, a submodule, a dangling link) is null, as `cat` skips it. @param {(file: string) => string} readFile @param {string} f */
function textOf(readFile, f) {
  try { return readFile(f) } catch { return null }
}

/**
 * One package line, as the prose loop's body made it for the manifest `f`: null when it has no `[package]`.
 * @param {string} f @param {ReturnType<typeof runner>} run @param {(file: string) => string} readFile
 */
function packageAt(f, run, readFile) {
  const manifest = textOf(readFile, f)
  if (manifest == null || !hasPackageSection(manifest)) return null
  const dir = dirnameOf(f)
  const code = rsPaths(run('git ls-files', 'git', ['ls-files', '--', dir])).reduce((n, rs) => n + countLines(textOf(readFile, rs) ?? ''), 0)
  const sig = countLines(run('git grep', 'git', ['grep', '-h', '-E', PUB_LINE, '--', dir], noMatch))
  return { dir, line: manifestLine(dir, code, sig, manifest) }
}

/**
 * The answer for the diff range `revs` in the working directory, or `{ roots: [], error }`.
 * @param {string[]} revs  `git diff`'s revision arguments
 * @param {{ exec?: Exec, readFile?: (file: string) => string, cwd?: string }} [io]  injected by tests
 * @returns {{ roots: string[], packages?: string[], numstat?: string[], error?: string }}
 */
export function collectUnits(revs, { cwd, exec = execIn(cwd), readFile = f => fs.readFileSync(path.resolve(cwd ?? '.', f), 'utf8') } = {}) {
  const bad = badRange(revs)
  if (bad) return { roots: [], error: `usage: craft-units [--merge-base] <rev>... — ${bad}` }
  const run = runner(exec)
  try {
    const manifests = readLines(run('git ls-files', 'git', ['ls-files', 'Cargo.toml', '*/Cargo.toml']))
    const packages = manifests.map(f => packageAt(f, run, readFile)).filter(p => p != null)
    const numstat = run('git diff', 'git', ['diff', '--numstat', '--no-renames', ...revs, '--'])
    return unitsAnswer(packages, numstat)
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
