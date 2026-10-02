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

/**
 * Fence lines in the scanned paths outside the engines, as `file:line: why`.
 * @param {string} root @param {string[]} paths  the scanned paths, relative to `root`
 * @returns {string[]}
 */
export function fenceProblems(root, paths) {
  /** @type {string[]} */
  const out = []
  for (const p of paths) {
    for (const file of walk(path.join(root, p))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (ENGINE.test(rel)) continue
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

/** @param {string} root @returns {string[]} */
export function checkDup(root = ROOT) {
  /** @type {{ path?: unknown }} */
  let config
  /** @type {{ clones?: unknown }} */
  let ceilingFile
  /** @type {unknown} */
  let baselineFile
  try {
    config = parseJsonObject(fs.readFileSync(path.join(root, '.jscpd.json'), 'utf8'))
    ceilingFile = parseJsonObject(fs.readFileSync(path.join(root, 'lib', 'dup-ceiling.json'), 'utf8'))
    baselineFile = parseJsonObject(fs.readFileSync(path.join(root, '.jscpd-baseline.json'), 'utf8'))
  } catch (e) { return [`unreadable gate input: ${/** @type {Error} */ (e).message}`] }
  const paths = Array.isArray(config.path) && config.path.every(p => typeof p === 'string') ? /** @type {string[]} */ (config.path) : null
  if (!paths?.length) return ['.jscpd.json names no `path` to scan']
  const baseline = baselineCount(baselineFile)
  if (baseline === null) return ['.jscpd-baseline.json is not a jscpd baseline ({ fingerprints: { <hash>: <count> } })']

  const problems = fenceProblems(root, paths)
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'jscpd.cmd' : 'jscpd')
  if (!fs.existsSync(bin)) return [...problems, 'jscpd is not installed — run npm ci']
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-jscpd-'))
  try {
    const run = spawnSync(bin, ['--reporters', 'console,json', '--output', out], { cwd: root, stdio: 'inherit' })
    if (run.status !== 0) problems.push(`jscpd exited ${String(run.status ?? run.signal)}: a clone not in .jscpd-baseline.json (listed above as [NEW]) is a new copy — unify it; an edit in or beside a baselined copy changes its fingerprint too — then run npm run check:dup:baseline, the count unchanged`)
    /** @type {{ duplicates?: unknown }} */
    const report = parseJsonObject(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8'))
    if (!Array.isArray(report.duplicates)) return [...problems, 'the jscpd report lists no `duplicates` — nothing to count']
    problems.push(...ceilingProblems({ baseline, ceiling: Number(ceilingFile.clones), found: report.duplicates.length }))
  } catch (e) {
    problems.push(`the jscpd report could not be read: ${/** @type {Error} */ (e).message}`)
  } finally { fs.rmSync(out, { recursive: true, force: true }) }
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDup()
  for (const p of problems) console.error(`FAIL ${p}`)
  if (problems.length) process.exit(1)
  console.log('check-dup: no copy outside the baseline, no fence outside the engines, the ceiling holds')
}
