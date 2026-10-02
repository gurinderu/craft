// The mutation floor may only rise. lib/mutation-floor.json holds the score below which the weekly
// Stryker run turns red (`break`) and what that score is measured over (`mutate`); lowering either would
// hide the very drop the run exists to show (realm @nick/craft, #146). The same ratchet as
// lib/dup-ceiling.json, pointing the other way: CI's `test` job compares the file against the PR's base
// on every pull request. Two more ways to lower the real floor with the number unchanged are closed here:
// a narrower `mutate` (a glob dropped, a `!` exclusion added) fails against the base — compared as sets,
// which is sound because the file's form puts every exclusion after every include, so a reorder cannot
// narrow what Stryker applies in order (lib/mutation-floor.mjs) — and a
// stryker.config.mjs whose `mutate` or `thresholds.break` is not the file's fails at head. The config is
// imported, not parsed: what Stryker reads is what is compared.
//
// Run: `node lib/check-mutation-floor.mjs --base <ref>` (e.g. `origin/main`); without `--base` only the
// file's form and the config's use of it are checked.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { FLOOR_FILE as FILE, isExclusion, parseFloor } from './mutation-floor.mjs'
import { runIfMain } from './script-main.mjs'

/** @typedef {import('./mutation-floor.mjs').Floor} Floor */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = 'stryker.config.mjs'

/**
 * @param {Floor} head  the floor in the change
 * @param {Floor | null} base  the floor on the base, null when the base has no floor file
 * @returns {string[]}
 */
export function floorProblems(head, base) {
  if (base === null) return []
  const problems = head.break < base.break
    ? [`${FILE} lowers the mutation floor from ${base.break} to ${head.break} — it may only rise: raise the score instead`]
    : []
  for (const g of base.mutate.filter((g) => !isExclusion(g) && !head.mutate.includes(g))) {
    problems.push(`${FILE} drops ${g} from \`mutate\` — what the floor is measured over may only widen`)
  }
  for (const g of head.mutate.filter((g) => isExclusion(g) && !base.mutate.includes(g))) {
    problems.push(`${FILE} adds the exclusion ${g} to \`mutate\` — what the floor is measured over may only widen`)
  }
  return problems
}

/**
 * Whether the Stryker config applies the floor file: its `mutate` and `thresholds.break` are the file's.
 * @param {unknown} config  the config module's default export
 * @param {Floor} floor
 * @returns {string[]}
 */
export function configProblems(config, floor) {
  const c = /** @type {{ mutate?: unknown, thresholds?: { break?: unknown } } | null | undefined} */ (config)
  const problems = []
  if (!isDeepStrictEqual(c?.mutate, floor.mutate)) problems.push(`${CONFIG}'s \`mutate\` is not ${FILE}'s \`mutate\``)
  if (c?.thresholds?.break !== floor.break) problems.push(`${CONFIG}'s \`thresholds.break\` is not ${FILE}'s \`break\``)
  return problems
}

/** @param {string} root @returns {Promise<{ config: unknown } | { problem: string }>} */
async function loadConfig(root) {
  try {
    const mod = /** @type {{ default?: unknown }} */ (await import(pathToFileURL(path.join(root, CONFIG)).href))
    return { config: mod.default }
  } catch (e) {
    return { problem: `${CONFIG} could not be imported: ${/** @type {Error} */ (e).message}` }
  }
}

/** @param {string} root @param {string[]} args @returns {{ ok: boolean, out: string }} */
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return { ok: r.status === 0, out: r.stdout }
}

/**
 * The floor on `base`: the file's contents, null when it is absent there, or the problem that stops the check.
 * @param {string} root @param {string} base
 * @returns {{ floor: Floor | null } | { problem: string }}
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
 * @param {string | null} base  the ref to compare against, null to check the file and the config only
 * @returns {Promise<string[]>}
 */
export async function checkMutationFloor(root = ROOT, base = null) {
  /** @type {Floor} */
  let head
  try { head = parseFloor(fs.readFileSync(path.join(root, FILE), 'utf8')) } catch (e) { return [/** @type {Error} */ (e).message] }
  const loaded = await loadConfig(root)
  const problems = 'problem' in loaded ? [loaded.problem] : configProblems(loaded.config, head)
  if (base === null) return problems
  const b = baseFloor(root, base)
  return [...problems, ...('problem' in b ? [b.problem] : floorProblems(head, b.floor))]
}

/**
 * The command (realm @nick/craft, #172): `--base <ref>` compares against that ref — a `--base` without a
 * ref fails as an unknown commit, not as an absent flag; without `--base` only the file and the config.
 * @param {string[]} argv  the arguments after the script's path
 * @param {NodeJS.ProcessEnv} _env  unused: the check reads no environment
 * @param {string} [root]  the checkout to check
 * @returns {Promise<import('./script-main.mjs').ScriptResult>}
 */
export async function run(argv, _env, root = ROOT) {
  const i = argv.indexOf('--base')
  const base = i === -1 ? null : (argv[i + 1] ?? '')
  const problems = await checkMutationFloor(root, base)
  if (problems.length) return { exitCode: 1, stdout: [], stderr: problems.map((p) => `FAIL ${p}`) }
  const said = base === null
    ? `check-mutation-floor: ${CONFIG} applies the well-formed floor file (no --base given, nothing compared)`
    : `check-mutation-floor: neither the floor nor what it is measured over falls against ${base}`
  return { exitCode: 0, stdout: [said], stderr: [] }
}

await runIfMain(import.meta.url, run)
