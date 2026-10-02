// The mutation floor may only rise. lib/mutation-floor.json holds the score below which the weekly
// Stryker run turns red (stryker.config.mjs reads it as `thresholds.break`); lowering it would hide the
// very drop the run exists to show (realm @nick/craft, #146). The same ratchet as lib/dup-ceiling.json,
// pointing the other way: CI's `test` job compares the file against the PR's base on every pull request.
//
// Run: `node lib/check-mutation-floor.mjs --base <ref>` (e.g. `origin/main`); without `--base` only the
// file's own form is checked.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonObject } from './json-object.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'lib/mutation-floor.json'

/**
 * @param {string} text  the floor file's contents
 * @returns {number} its `break`, a percentage
 * @throws {Error} naming the file, when it is not `{ "break": <0..100> }`
 */
export function parseFloor(text) {
  /** @type {unknown} */
  let floor
  try { floor = /** @type {Record<string, unknown>} */ (parseJsonObject(text))['break'] } catch { floor = undefined }
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 100) {
    throw new Error(`${FILE} must be { "break": <a percentage, 0 to 100> }`)
  }
  return floor
}

/**
 * @param {number} head  the floor in the change
 * @param {number | null} base  the floor on the base, null when the base has no floor file
 * @returns {string[]}
 */
export function floorProblems(head, base) {
  if (base === null || head >= base) return []
  return [`${FILE} lowers the mutation floor from ${base} to ${head} — it may only rise: raise the score instead`]
}

/** @param {string} root @param {string[]} args @returns {{ ok: boolean, out: string }} */
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { ok: r.status === 0, out: r.stdout }
}

/**
 * The floor on `base`: a number, null when the file is absent there, or the problem that stops the check.
 * @param {string} root @param {string} base
 * @returns {{ floor: number | null } | { problem: string }}
 */
function baseFloor(root, base) {
  if (!git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    return { problem: `the base ${base} is not a commit in this repository — fetch it first` }
  }
  if (!git(root, ['cat-file', '-e', `${base}:${FILE}`]).ok) return { floor: null }
  try { return { floor: parseFloor(git(root, ['show', `${base}:${FILE}`]).out) } } catch (e) {
    return { problem: `on the base ${base}: ${/** @type {Error} */ (e).message}` }
  }
}

/**
 * Every problem, empty when the floor holds.
 * @param {string} root  the checkout whose working tree holds the change
 * @param {string | null} base  the ref to compare against, null to check the file's form only
 * @returns {string[]}
 */
export function checkMutationFloor(root = ROOT, base = null) {
  /** @type {number} */
  let head
  try { head = parseFloor(fs.readFileSync(path.join(root, FILE), 'utf8')) } catch (e) { return [/** @type {Error} */ (e).message] }
  if (base === null) return []
  const b = baseFloor(root, base)
  return 'problem' in b ? [b.problem] : floorProblems(head, b.floor)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--base')
  const base = i === -1 ? null : (process.argv[i + 1] ?? '')
  const problems = checkMutationFloor(ROOT, base)
  for (const p of problems) console.error(`FAIL ${p}`)
  if (problems.length) process.exit(1)
  console.log(base === null ? 'check-mutation-floor: the floor file is well-formed (no --base given, nothing compared)' : `check-mutation-floor: the floor does not fall against ${base}`)
}
