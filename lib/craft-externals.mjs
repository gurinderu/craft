// The discovery CLI (realm @nick/craft, node #435 under #375): the candidates for memory records of kind `external`
// (node #434) that the consumer's deployment manifests name — Helm charts and values, kustomizations, docker-compose,
// plain Kubernetes manifests, flake.lock, Terraform git modules — derived by code, never by a model. It writes
// nothing: a candidate becomes a record only on the human's word, through record-external (node #436, #206).
//
// Run: node lib/craft-externals.mjs discover --repo-root <absolute dir> [--paths <base64url JSON list>] [--known -]
// Without --paths it walks the whole repository (dot directories, node_modules, vendor and target skipped); with it,
// it reads only those repo-relative files (the review engine's touched manifests). `--known -` reads the project's
// `external` records as JSON on stdin and leaves out every candidate one of them covers. Prints
// {"candidates":[...], "more": <past the bound>, "unread":[{file, error}]} — plus "walkCut": "<why>" when the walk
// stopped at its bound, so files past it were not read — and exits 0; a malformed invocation prints {"error":"..."}, exit 1.
import fs from 'node:fs'
import path from 'node:path'
import { runIfMain } from './script-main.mjs'
import { readRepoFile } from './repo-file.mjs'
import { candidatesIn } from './manifest-discover.mjs'
import { MANIFESTS_MAX, manifestKind } from './manifest-paths.mjs'
import { coveredBy } from './external-candidate.mjs'

const FILE_MAX = 1024 * 1024
const WALK_MAX = 100_000
const CANDIDATES_MAX = 64
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target'])
const USAGE = 'usage: craft-externals discover --repo-root <absolute dir> [--paths <base64url JSON list>] [--known -]'

/** @typedef {import('./external-candidate.mjs').Candidate} Candidate @typedef {import('./external-candidate.mjs').RecordLike} RecordLike */

/** The options after the verb, each once and known, else why not. @param {string[]} argv @returns {{ opts: Record<string, string> } | { error: string }} */
function readOptions(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  for (let i = 1; i < argv.length; i += 2) {
    const k = String(argv[i])
    if (!['--repo-root', '--paths', '--known'].includes(k) || k in opts) return { error: `unexpected option ${JSON.stringify(k)}` }
    opts[k] = String(argv[i + 1])
  }
  return { opts }
}

/** The command line read. @param {string[]} argv @returns {{ repoRoot: string, paths?: string[], known: boolean } | { error: string }} */
export function parseArgv(argv) {
  if (argv[0] !== 'discover' || argv.length % 2 !== 1) return { error: USAGE }
  const read = readOptions(argv)
  if ('error' in read) return read
  const { opts } = read
  const [repoRoot, known] = [opts['--repo-root'] ?? '', '--known' in opts]
  if (!path.isAbsolute(repoRoot)) return { error: '--repo-root is missing or not an absolute path' }
  if (known && opts['--known'] !== '-') return { error: '--known takes only "-" (the records as JSON on stdin)' }
  if (!('--paths' in opts)) return { repoRoot, known }
  const paths = decodePaths(String(opts['--paths']))
  return 'error' in paths ? paths : { repoRoot, paths: paths.list, known }
}

/** --paths decoded: 1..MANIFESTS_MAX repo-relative paths. @param {string} b64 @returns {{ list: string[] } | { error: string }} */
function decodePaths(b64) {
  /** @type {unknown} */
  let list
  try { list = /^[A-Za-z0-9_-]+$/.test(b64) ? JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) : null } catch { list = null }
  const ok = Array.isArray(list) && list.length >= 1 && list.length <= MANIFESTS_MAX
    && list.every(p => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split('/').includes('..'))
  return ok ? { list: /** @type {string[]} */ (list) } : { error: `--paths is not base64url JSON of 1..${MANIFESTS_MAX} repo-relative paths` }
}

/**
 * The repository's files that may be manifests, repo-relative, in a stable order, and whether the walk stopped at
 * its bound of `max` directory entries (the files past it unread).
 * @param {string} root @param {number} [max] @returns {{ files: string[], cut: boolean }}
 */
export function walkManifests(root, max = WALK_MAX) {
  /** @type {string[]} */
  const found = []
  let seen = 0
  let cut = false
  /** @param {string} rel */
  const visit = rel => {
    /** @type {fs.Dirent[]} */
    let entries
    // A directory that cannot be listed (permissions) is passed over, not the whole walk failed.
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (++seen > max) {
        cut = true
        return
      }
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) visit(p)
      else if (e.isFile() && manifestKind(p)) found.push(p)
    }
  }
  visit('')
  return { files: found, cut }
}

/** The `external` records in the JSON on stdin: a list, or an object holding one under `externals` or `records`. @param {string} raw */
export function knownRecords(raw) {
  /** @type {unknown} */
  let v
  try { v = JSON.parse(raw) } catch { return null }
  const o = /** @type {Record<string, unknown>} */ (v && typeof v === 'object' ? v : {})
  const list = Array.isArray(v) ? v : Array.isArray(o['externals']) ? o['externals'] : Array.isArray(o['records']) ? o['records'] : null
  return list ? list.filter(r => r && typeof r === 'object' && (!r.kind || r.kind === 'external') && (!r.status || r.status === 'active')) : null
}

/**
 * The candidates of `files` no record of `known` covers, at most CANDIDATES_MAX, and each file that could not be read.
 * @param {string} repoReal @param {string[]} files @param {RecordLike[]} known
 */
function candidatesOf(repoReal, files, known) {
  /** @type {Candidate[]} */
  const candidates = []
  /** @type {{ file: string, error: string }[]} */
  const unread = []
  for (const file of files) {
    /** @type {string} */
    let text
    try { text = readRepoFile(repoReal, file, { max: FILE_MAX, label: 'manifest' }) } catch (e) {
      unread.push({ file, error: e instanceof Error ? e.message : String(e) })
      continue
    }
    candidates.push(...candidatesIn(file, text).filter(c => !coveredBy(c, known)))
  }
  return { candidates: candidates.slice(0, CANDIDATES_MAX), more: Math.max(0, candidates.length - CANDIDATES_MAX), unread }
}

/** The whole repository walked: its candidates, and `walkCut` when the walk stopped at its bound. @param {string} repoReal @param {RecordLike[]} known @param {number} walkMax */
function walkedCandidates(repoReal, known, walkMax) {
  const walk = walkManifests(repoReal, walkMax)
  const found = candidatesOf(repoReal, walk.files, known)
  return walk.cut ? { ...found, walkCut: `the walk stopped at its bound of ${walkMax} directory entries: files past it were not read — name them with --paths` } : found
}

/**
 * The answer for a command line, and its exit code.
 * @param {string[]} argv @param {{ stdin?: () => string, walkMax?: number }} [io]  injected by tests
 * @returns {{ exitCode: number, answer: { candidates?: Candidate[], more?: number, unread?: { file: string, error: string }[], walkCut?: string, error?: string } }}
 */
export function discover(argv, { stdin = () => fs.readFileSync(0, 'utf8'), walkMax = WALK_MAX } = {}) {
  const args = parseArgv(argv)
  if ('error' in args) return { exitCode: 1, answer: { error: args.error } }
  /** @type {string} */
  let repoReal
  try { repoReal = fs.realpathSync(args.repoRoot) } catch { return { exitCode: 1, answer: { error: `--repo-root ${args.repoRoot} does not exist` } } }
  const known = args.known ? knownRecords(stdin()) : []
  if (!known) return { exitCode: 1, answer: { error: '--known -: stdin is not JSON of a list of records' } }
  return { exitCode: 0, answer: args.paths ? candidatesOf(repoReal, args.paths, known) : walkedCandidates(repoReal, known, walkMax) }
}

/** @param {string[]} argv @returns {Promise<import('./script-main.mjs').ScriptResult>} */
export async function run(argv) {
  const { exitCode, answer } = discover(argv.map(String))
  return { exitCode, stdout: [JSON.stringify(answer)], stderr: [] }
}

await runIfMain(import.meta.url, run)
