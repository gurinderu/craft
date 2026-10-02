// The duplication gate: jscpd over the paths in .jscpd.json, plus the two things jscpd cannot hold.
//
// 1. Its ignorePattern skips every craft-inline region — in any file it scans. Only the engines'
//    fences are checked against their lib source (check-workflows), so a fence-shaped pair anywhere
//    else would hide a real copy with every gate green. Such lines are refused outside workflows/*.js.
// 2. Its baseline accepts whatever `--update-baseline` last saw: a new copy absorbed by regenerating
//    reads as clean. The count of accepted copies is held to lib/dup-ceiling.json, which may only
//    fall (the same ratchet as the engines' `any` ceiling, realm @nick/craft, #136): raising it is a
//    visible edit, and a baseline that still lists a copy no longer found must be regenerated, so the
//    ceiling comes down with it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FENCE_CLOSE, FENCE_OPEN } from './inline-regions.mjs'
import { parseJsonObject } from './json-object.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = /^workflows\/[^/]+\.js$/

/** @param {string} dir @returns {string[]} every file under `dir`, node_modules skipped */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

// The files jscpd reads under .jscpd.json's `format` (javascript, typescript), a little wider on purpose:
// a refusal of a file it would not scan is loud, a file it scans and this skips would be silent.
const SCANNED_EXT = /\.[cm]?[jt]sx?$/

/**
 * Fence lines outside the engines in the files jscpd scans — `paths` minus the `ignore` globs, as in
 * .jscpd.json — as `file:line: why`. A fence-shaped line in a file jscpd never reads hides nothing.
 * @param {string} root @param {{ paths: string[], ignore: string[] }} scan  relative to `root`
 * @returns {string[]}
 */
export function fenceProblems(root, { paths, ignore }) {
  /** @type {string[]} */
  const out = []
  for (const p of paths) {
    for (const file of walk(path.join(root, p))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (ENGINE.test(rel) || !SCANNED_EXT.test(rel) || ignore.some(g => path.matchesGlob(rel, g))) continue
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (FENCE_OPEN.test(line) || FENCE_CLOSE.test(line)) {
          out.push(`${rel}:${i + 1}: a craft-inline fence outside workflows/*.js — jscpd skips what it encloses, and only engine fences are checked against their source`)
        }
      })
    }
  }
  return out
}

/** @param {unknown} baseline  parsed .jscpd-baseline.json @returns {number | null} accepted copies, or null if unreadable */
export function baselineCount(baseline) {
  const fp = baseline && typeof baseline === 'object' ? /** @type {{ fingerprints?: unknown }} */ (baseline).fingerprints : undefined
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return null
  let n = 0
  for (const v of Object.values(fp)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null
    n += v
  }
  return n
}

/**
 * @param {{ baseline: number, ceiling: number, found: number }} counts  accepted copies, their ceiling, clones this run found
 * @returns {string[]}
 */
export function ceilingProblems({ baseline, ceiling, found }) {
  if (!Number.isInteger(ceiling) || ceiling < 0) return ['no ceiling for the accepted copies in lib/dup-ceiling.json — the baseline could grow unseen']
  /** @type {string[]} */
  const out = []
  if (baseline > ceiling) out.push(`.jscpd-baseline.json holds ${baseline} accepted copies, above the ceiling ${ceiling} in lib/dup-ceiling.json — a regenerated baseline absorbed a new copy: unify it, or raise the ceiling as a visible edit with its reason in the PR`)
  else if (baseline < ceiling) out.push(`.jscpd-baseline.json holds ${baseline} accepted copies, below the ceiling ${ceiling} — lower the ceiling to ${baseline} in lib/dup-ceiling.json`)
  if (found < baseline) out.push(`${baseline - found} fingerprint(s) no longer found in this run — a baselined copy was unified or moved: run npm run check:dup:baseline (the count must not rise) and lower the ceiling to match`)
  return out
}

/** @typedef {{ status: number | null, error?: Error }} JscpdExit */
/** jscpd from the root's install, its JSON report into `out`. @param {string} root @param {string} out @returns {JscpdExit} */
function runJscpd(root, out) {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'jscpd.cmd' : 'jscpd')
  const r = spawnSync(bin, ['--reporters', 'console,json', '--output', out], { cwd: root, stdio: 'inherit' })
  return r.error ? { status: r.status, error: r.error } : { status: r.status }
}

/** @param {unknown} v @returns {string[] | null} */
const strings = v => (Array.isArray(v) && v.every(x => typeof x === 'string') ? /** @type {string[]} */ (v) : null)

/** @param {string} root @param {string} name @returns {Record<string, unknown>} */
const readJson = (root, name) => parseJsonObject(fs.readFileSync(path.join(root, name), 'utf8'))

/**
 * The gate's inputs, or the one problem that stops it before jscpd runs.
 * @param {string} root
 * @returns {{ problem: string } | { paths: string[], ignore: string[], baseline: number, ceiling: number }}
 */
function readInputs(root) {
  /** @type {Record<string, unknown>} */
  let config
  /** @type {Record<string, unknown>} */
  let ceilingFile
  /** @type {unknown} */
  let baselineFile
  try {
    config = readJson(root, '.jscpd.json')
    ceilingFile = readJson(root, path.join('lib', 'dup-ceiling.json'))
    baselineFile = readJson(root, '.jscpd-baseline.json')
  } catch (e) { return { problem: `unreadable gate input: ${/** @type {Error} */ (e).message}` } }
  const paths = strings(config['path'])
  const ignore = config['ignore'] === undefined ? [] : strings(config['ignore'])
  if (!paths?.length || !ignore) return { problem: '.jscpd.json needs `path` (and `ignore`, if any) as lists of strings' }
  const baseline = baselineCount(baselineFile)
  if (baseline === null) return { problem: '.jscpd-baseline.json is not a jscpd baseline ({ fingerprints: { <hash>: <count> } })' }
  return { paths, ignore, baseline, ceiling: Number(ceilingFile['clones']) }
}

/** @param {string} out @returns {unknown[] | null} the report's duplicates, null when there is no readable report */
function readDuplicates(out) {
  try {
    const report = readJson(out, 'jscpd-report.json')
    return Array.isArray(report['duplicates']) ? report['duplicates'] : null
  } catch { return null }
}

/**
 * What jscpd's run says: a failure to run or to report, a new clone, or a non-zero exit with nothing new.
 * @param {JscpdExit} exit @param {unknown[] | null} dups
 * @returns {string[]}
 */
function runProblems(exit, dups) {
  if (exit.error) return [`jscpd could not run (${exit.error.message}) — run npm ci`]
  const status = String(exit.status ?? 'on a signal')
  if (!dups) return [`jscpd exited ${status} without a report — see its output above: a missing platform package (run npm ci) or an error in .jscpd.json`]
  const fresh = dups.filter(d => !!d && typeof d === 'object' && /** @type {{ isNew?: unknown }} */ (d).isNew === true).length
  if (fresh) return [`${fresh} clone(s) not in .jscpd-baseline.json (marked [NEW] above): a new copy — unify it; an edit in or beside a baselined copy changes its fingerprint too — then run npm run check:dup:baseline, the count unchanged`]
  if (exit.status !== 0) return [`jscpd exited ${status} with no new clone in its report — see its output above (an error in .jscpd.json, a reporter, an empty scan)`]
  return []
}

/**
 * Every problem, empty when the gate holds. A new clone is read from jscpd's own report, not its exit:
 * a non-zero exit with nothing new in the report is jscpd failing, and fails the gate as that.
 * @param {string} root @param {(root: string, out: string) => JscpdExit} run
 * @returns {string[]}
 */
export function checkDup(root = ROOT, run = runJscpd) {
  const inputs = readInputs(root)
  if ('problem' in inputs) return [inputs.problem]
  const problems = fenceProblems(root, { paths: inputs.paths, ignore: inputs.ignore })
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-jscpd-'))
  try {
    const exit = run(root, out)
    const dups = exit.error ? null : readDuplicates(out)
    const fromRun = runProblems(exit, dups)
    if (!dups) return [...problems, ...fromRun]
    return [...problems, ...fromRun, ...ceilingProblems({ baseline: inputs.baseline, ceiling: inputs.ceiling, found: dups.length })]
  } finally { fs.rmSync(out, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDup()
  for (const p of problems) console.error(`FAIL ${p}`)
  if (problems.length) process.exit(1)
  console.log('check-dup: no copy outside the baseline, no fence outside the engines, the ceiling holds')
}
