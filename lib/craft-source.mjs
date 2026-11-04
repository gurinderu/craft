// The external-sources CLI (realm @nick/craft, node #430 under #375): a review lens reads the source of a system
// the consumer's code relies on (kube-ovn, KubeVirt, an apiserver) at the version the consumer deploys, and
// everything about getting that source has one correct result, so it is code, not a model. For each system of
// the spec the ENGINE built from the memory records of kind `external` (node #431): read the revision from the
// consumer's file (`versionFrom`, inside the repository) with its pattern (`versionMatch`, one capture group),
// check the repository URL and that the revision is a tag (or its `v` spelling: `1.12.3` → `v1.12.3`) or a commit
// (lib/source-checkout.mjs), and hand back a shallow copy of the source in the cache —
// `$CRAFT_SOURCES_DIR`, else `~/.craft/sources`, at `<host>/<path>@<ref>`: reused when present, else fetched
// into a temporary sibling and renamed into place (a rename that loses a race drops its copy and takes the
// winner's). `.git` is dropped once checked out: a lens reads files, never history. The probe stays an agent
// only because the Workflow sandbox cannot spawn a process (#134).
//
// Run: node lib/craft-source.mjs prepare --repo-root <absolute dir> --spec <base64url JSON>
// Prints {"systems":[{system, ref, dir} | {system, error}]} and exits 0, a failed system included; a malformed
// invocation (another verb or option, a spec that is not base64url JSON of 1..8 systems, a relative root or
// cache directory) prints {"error":"..."} and exits 1. No option a model could compose rides through.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runIfMain } from './script-main.mjs'
import { readRepoFile } from './repo-file.mjs'
import { EXTERNALS_MAX, SYSTEM_NAME, cacheSegments, readRef, repoUrlParts, versionPattern } from './external-source-spec.mjs'
import { cachedCopy, execGit, gitEnv } from './source-checkout.mjs'

const VERSION_FILE_MAX = 4 * 1024 * 1024
const SPEC_MAX = 64 * 1024

/** @typedef {import('./source-checkout.mjs').Exec} Exec */
/** @typedef {{ system: string, ref: string, dir: string } | { system: string, error: string }} SystemAnswer */

/** The cache root, or why there is none. @param {NodeJS.ProcessEnv} env @returns {{ root: string } | { error: string }} */
export function sourcesRoot(env) {
  const set = env['CRAFT_SOURCES_DIR']
  if (set) return path.isAbsolute(set) ? { root: set } : { error: `CRAFT_SOURCES_DIR is not absolute: ${set}` }
  return { root: path.join(env['HOME'] || os.homedir(), '.craft', 'sources') }
}

/** The command line read: `prepare --repo-root <abs> --spec <b64url>`, the two options in either order. @param {string[]} argv */
export function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  if (argv[0] !== 'prepare' || argv.length !== 5) return { error: 'usage: craft-source prepare --repo-root <absolute dir> --spec <base64url JSON>' }
  for (let i = 1; i < 5; i += 2) {
    const [k, v] = [String(argv[i]), String(argv[i + 1])]
    if ((k !== '--repo-root' && k !== '--spec') || k in opts) return { error: `unexpected option ${JSON.stringify(k)}` }
    opts[k] = v
  }
  const [repoRoot, spec] = [String(opts['--repo-root']), String(opts['--spec'])]
  if (!path.isAbsolute(repoRoot)) return { error: '--repo-root is not an absolute path' }
  return { repoRoot, spec }
}

/** The spec decoded: 1..EXTERNALS_MAX objects of four strings each. @param {string} b64 @returns {{ entries: Record<string, string>[] } | { error: string }} */
export function decodeSpec(b64) {
  if (!/^[A-Za-z0-9_-]+$/.test(b64) || b64.length > SPEC_MAX) return { error: '--spec is not base64url' }
  /** @type {unknown} */
  let list
  try { list = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) } catch { return { error: '--spec is not base64url JSON' } }
  const keys = ['system', 'repo', 'versionFrom', 'versionMatch']
  const ok = Array.isArray(list) && list.length >= 1 && list.length <= EXTERNALS_MAX
    && list.every(e => e && typeof e === 'object' && keys.every(k => typeof e[k] === 'string'))
  return ok ? { entries: /** @type {Record<string, string>[]} */ (list) } : { error: `--spec is not a list of 1..${EXTERNALS_MAX} {system, repo, versionFrom, versionMatch}` }
}

/** One system of the spec. @param {Record<string, string>} e @param {{ repoReal: string, root: string, exec: Exec }} ctx @returns {SystemAnswer} */
export function prepareSystem(e, { repoReal, root, exec }) {
  const system = String(e['system'])
  /** @param {string} error @returns {SystemAnswer} */
  const fail = error => ({ system, error })
  if (!SYSTEM_NAME.test(system)) return fail('system is not a name of letters, digits, ".", "_" or "-"')
  const parts = repoUrlParts(String(e['repo']))
  if ('error' in parts) return fail(parts.error)
  const pattern = versionPattern(String(e['versionMatch']))
  if ('error' in pattern) return fail(pattern.error)
  try {
    const read = readRef(pattern.re, readRepoFile(repoReal, String(e['versionFrom']), { max: VERSION_FILE_MAX, label: 'versionFrom' }))
    if ('error' in read) return fail(read.error)
    return { system, ...cachedCopy(exec, String(e['repo']), read.ref, ref => path.join(root, ...cacheSegments(parts, ref))) }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * The answer for a command line, and its exit code.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {{ exec?: Exec }} [io]  injected by tests
 * @returns {{ exitCode: number, answer: { systems?: SystemAnswer[], error?: string } }}
 */
export function prepare(argv, env, { exec = execGit(gitEnv(env)) } = {}) {
  const args = parseArgv(argv)
  if ('error' in args) return { exitCode: 1, answer: { error: args.error } }
  const spec = decodeSpec(args.spec)
  if ('error' in spec) return { exitCode: 1, answer: { error: spec.error } }
  const where = sourcesRoot(env)
  if ('error' in where) return { exitCode: 1, answer: { error: where.error } }
  /** @type {string} */
  let repoReal
  try { repoReal = fs.realpathSync(args.repoRoot) } catch { return { exitCode: 1, answer: { error: `--repo-root ${args.repoRoot} does not exist` } } }
  return { exitCode: 0, answer: { systems: spec.entries.map(e => prepareSystem(e, { repoReal, root: where.root, exec })) } }
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @returns {Promise<import('./script-main.mjs').ScriptResult>} */
export async function run(argv, env) {
  const { exitCode, answer } = prepare(argv.map(String), env)
  return { exitCode, stdout: [JSON.stringify(answer)], stderr: [] }
}

await runIfMain(import.meta.url, run)
