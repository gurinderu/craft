// The discovery CLI (realm @nick/craft, node #435 under #375): the integration-point candidates (node #434) that
// the consumer's deployment manifests name — Helm charts and values, kustomizations, docker-compose,
// plain Kubernetes manifests, Terraform git modules — derived by code, never by a model. It writes
// nothing: `craft init --propose` shows the candidates, and one becomes an integration point only on the reviewer's
// word (`craft init --write`; nodes #467, #470).
//
// Run: node lib/craft-externals.mjs discover --repo-root <absolute dir> [--paths <base64url JSON list>] [--known -]
// Without --paths it walks the whole repository (dot directories, node_modules, vendor and target skipped); with it,
// it reads only those repo-relative files (the review engine's touched manifests). `--known -` reads the project's
// `external` records as JSON on stdin and leaves out every candidate one of them covers. A candidate whose repo,
// stated or guessed, is the repository's own (its `origin` remote; none, no such filter) is the consumer's own
// application and is left out too (realm @nick/craft, node #435). Prints
// {"candidates":[...], "more": <past the bound>, "unread":[{file, error}]} — plus "walkCut": "<why>" when the walk
// stopped at its bound, so files past it were not read — and exits 0; a malformed invocation prints {"error":"..."}, exit 1.
// Its second verb, `memory`, reads the memory's own `external` records as candidates of `craft init --propose`
// (lib/craft-externals-memory.mjs, node #470).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runIfMain } from './script-main.mjs'
import { readRepoFile } from './repo-file.mjs'
import { candidatesIn } from './manifest-discover.mjs'
import { manifestKind } from './manifest-paths.mjs'
import { coveredBy, sameRepo } from './external-candidate.mjs'
import { parseArgv } from './craft-externals-argv.mjs'
import { memoryExternals, recordList } from './craft-externals-memory.mjs'

const FILE_MAX = 1024 * 1024
const WALK_MAX = 100_000
const CANDIDATES_MAX = 64
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target'])

/** @typedef {import('./external-candidate.mjs').Candidate} Candidate @typedef {import('./external-candidate.mjs').RecordLike} RecordLike */

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
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
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

/**
 * The active `external` records in the JSON on stdin: a list, or an object holding one under `externals` or `records`.
 * @param {string} raw @returns {RecordLike[] | null}
 */
export function knownRecords(raw) {
  const list = /** @type {Array<Record<string, unknown> | null> | null} */ (recordList(raw))
  /** @param {Record<string, unknown> | null} r */
  const active = r => !!r && typeof r === 'object' && (!r['kind'] || r['kind'] === 'external') && (!r['status'] || r['status'] === 'active')
  return list ? /** @type {RecordLike[]} */ (list.filter(active)) : null
}

/** The URL of the repository's `origin` remote, credentials dropped; '' when it has none (or git is not there). @param {string} repoReal */
export function originUrl(repoReal) {
  try {
    return execFileSync('git', ['-C', repoReal, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
      .trim()
      .replace(/^https:\/\/[^@/]+@/, 'https://')
  } catch {
    return ''
  }
}

/**
 * The candidates of `files` no record of `known` covers and not the repository's own (`self`, its origin URL), at
 * most CANDIDATES_MAX, and each file that could not be read.
 * @param {string} repoReal @param {string[]} files @param {RecordLike[]} known @param {string} self
 */
function candidatesOf(repoReal, files, known, self) {
  /** @type {Candidate[]} */
  const candidates = []
  /** @type {{ file: string, error: string }[]} */
  const unread = []
  for (const file of files) {
    /** @type {string} */
    let text
    try {
      text = readRepoFile(repoReal, file, { max: FILE_MAX, label: 'manifest' })
    } catch (e) {
      unread.push({ file, error: e instanceof Error ? e.message : String(e) })
      continue
    }
    candidates.push(...candidatesIn(file, text).filter(c => !coveredBy(c, known) && !(self && sameRepo(c.repo, self))))
  }
  return { candidates: candidates.slice(0, CANDIDATES_MAX), more: Math.max(0, candidates.length - CANDIDATES_MAX), unread }
}

/** The whole repository walked: its candidates, and `walkCut` when the walk stopped at its bound. @param {string} repoReal @param {RecordLike[]} known @param {string} self @param {number} walkMax */
function walkedCandidates(repoReal, known, self, walkMax) {
  const walk = walkManifests(repoReal, walkMax)
  const found = candidatesOf(repoReal, walk.files, known, self)
  return walk.cut
    ? { ...found, walkCut: `the walk stopped at its bound of ${walkMax} directory entries: files past it were not read — name them with --paths` }
    : found
}

/**
 * The answer for a command line, and its exit code.
 * @param {string[]} argv @param {{ stdin?: () => string, walkMax?: number, origin?: (repoReal: string) => string }} [io]  injected by tests
 * @returns {{ exitCode: number, answer: { candidates?: Candidate[], more?: number, unread?: { file: string, error: string }[], walkCut?: string, error?: string } }}
 */
export function discover(argv, { stdin = () => fs.readFileSync(0, 'utf8'), walkMax = WALK_MAX, origin = originUrl } = {}) {
  const args = parseArgv(argv)
  if ('error' in args) return { exitCode: 1, answer: { error: args.error } }
  /** @type {string} */
  let repoReal
  try {
    repoReal = fs.realpathSync(args.repoRoot)
  } catch {
    return { exitCode: 1, answer: { error: `--repo-root ${args.repoRoot} does not exist` } }
  }
  const known = args.known ? knownRecords(stdin()) : []
  if (!known) return { exitCode: 1, answer: { error: '--known -: stdin is not JSON of a list of records' } }
  const self = origin(repoReal)
  return { exitCode: 0, answer: args.paths ? candidatesOf(repoReal, args.paths, known, self) : walkedCandidates(repoReal, known, self, walkMax) }
}

/** @param {string[]} argv @returns {import('./script-main.mjs').ScriptResult} */
export function run(argv) {
  const args = argv.map(String)
  const { exitCode, answer } = args[0] === 'memory' ? memoryExternals(args) : discover(args)
  return { exitCode, stdout: [JSON.stringify(answer)], stderr: [] }
}

await runIfMain(import.meta.url, run)
