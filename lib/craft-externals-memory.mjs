// The project memory's `external` records (realm @nick/craft, node #431) as candidate integration points of the
// reviewer's profile (node #467) — the owner's decision on node #470, option (a): `craft init --propose` hands this
// the records the craft:memory skill recalled, and each one's deployed revision is read here as a review reads it
// (lib/external-revision.mjs): from the consumer's file with its pattern, or the version the human stated. The reviewer
// then confirms a system, its source and its revision rather than typing them; nothing is written here.
//
// Run: node lib/craft-externals.mjs memory --repo-root <absolute dir>, the records as JSON on stdin: a list, or an
// object holding one under `externals` or `records`; a record of another kind is passed over. Prints
// {"candidates":[{system, repo, ref, scope, versionFrom, versionMatch} | {system, repo, ref, scope, version}],
// "refused":["<why a record gave no candidate>"]} and exits 0; a malformed invocation or stdin prints {"error"}, exit 1.
import fs from 'node:fs'
import path from 'node:path'
import { externalRecords } from './external-record.mjs'
import { revisionOf } from './external-revision.mjs'

/** @typedef {import('./external-source-spec.mjs').ExternalRecord} ExternalRecord */
/** @typedef {{ system: string, repo: string, ref: string, scope: string, versionFrom?: string, versionMatch?: string, version?: string }} MemoryCandidate */

const USAGE = 'usage: craft-externals memory --repo-root <absolute dir> (the external records as JSON on stdin)'

/**
 * The list of records in JSON text: the list itself, or the one an object holds under `externals` or `records`; null
 * when it holds none. Also how the discovery reads its `--known -` (lib/craft-externals.mjs). @param {string} raw @returns {unknown[] | null}
 */
export function recordList(raw) {
  /** @type {unknown} */
  let v
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const o = /** @type {Record<string, unknown>} */ (v && typeof v === 'object' ? v : {})
  return Array.isArray(v) ? v : Array.isArray(o['externals']) ? o['externals'] : Array.isArray(o['records']) ? o['records'] : null
}

/** The records in the JSON on stdin, those of another kind passed over; null when it holds no list. @param {string} raw @returns {unknown[] | null} */
export function memoryRecords(raw) {
  return recordList(raw)?.filter(r => !(r && typeof r === 'object' && 'kind' in r) || /** @type {Record<string, unknown>} */ (r)['kind'] === 'external') ?? null
}

/** The repository root of `memory --repo-root <absolute dir>`, resolved, or why the command line is not that. @param {string[]} argv @returns {{ repoReal: string } | { error: string }} */
function rootOf(argv) {
  if (argv.length !== 3 || argv[0] !== 'memory' || argv[1] !== '--repo-root') return { error: USAGE }
  const root = String(argv[2])
  if (!path.isAbsolute(root)) return { error: '--repo-root is not an absolute path' }
  try {
    return { repoReal: fs.realpathSync(root) }
  } catch {
    return { error: `--repo-root ${root} does not exist` }
  }
}

/**
 * One usable record as a candidate: its revision read, or why it cannot be.
 * @param {string} repoReal @param {ExternalRecord} r @returns {{ candidate: MemoryCandidate } | { error: string }}
 */
function candidateOf(repoReal, r) {
  /** @type {{ ref: string } | { error: string }} */
  let read
  try {
    read = revisionOf(repoReal, /** @type {Record<string, string>} */ (/** @type {unknown} */ (r)))
  } catch (e) {
    read = { error: e instanceof Error ? e.message : String(e) }
  }
  if ('error' in read) return { error: `external record ${r.system}: ${read.error}` }
  const from = r.version ? { version: r.version } : { versionFrom: r.versionFrom, versionMatch: r.versionMatch }
  return { candidate: { system: r.system, repo: r.repo, ref: read.ref, scope: r.scope, ...from } }
}

/**
 * The answer for a command line, and its exit code.
 * @param {string[]} argv @param {{ stdin?: () => string }} [io]  injected by tests
 * @returns {{ exitCode: number, answer: { candidates?: MemoryCandidate[], refused?: string[], error?: string } }}
 */
export function memoryExternals(argv, { stdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  const root = rootOf(argv)
  if ('error' in root) return { exitCode: 1, answer: { error: root.error } }
  const { repoReal } = root
  const list = memoryRecords(stdin())
  if (!list) return { exitCode: 1, answer: { error: 'stdin is not JSON of a list of records' } }
  const { records, refused } = externalRecords(list)
  /** @type {MemoryCandidate[]} */
  const candidates = []
  for (const r of records) {
    const got = candidateOf(repoReal, r)
    if ('error' in got) refused.push(got.error)
    else candidates.push(got.candidate)
  }
  return { exitCode: 0, answer: { candidates, refused } }
}
