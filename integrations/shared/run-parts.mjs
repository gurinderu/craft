// A CLI run stopped and resumed files a record per part: the part its host stopped driving files INCOMPLETE, the
// resume's part files the run's verdict, and each names the binary's run directory (`cliRun`). Counted once, as the
// binary's `craft runs` readers count it (cli/crates/craft-store/src/parts.rs): a stopped part of a run that also
// filed a finished record folds into it, the finished record standing for the run; a run whose every part stopped
// stands as its newest. Each part is its own Workflow run with its own cost, so the standing record carries the sum
// of every part's — a part whose cost is not usable counted as `skipped`, so the run's cost reads as measured in part
// (run-record.mjs, costProblem). A record that names no run directory, filed before records named it, folds on
// nothing here.
import { costProblem, costTotal } from './run-record.mjs'

/** @typedef {import('./run-record.mjs').RecordCost} RecordCost */

const COUNTS = /** @type {const} */ (['output', 'input', 'cacheRead', 'cacheWrite', 'agents'])

/** @param {Record<string, unknown>} r @returns {string} */
function partKey(r) {
  const run = typeof r['cliRun'] === 'string' ? r['cliRun'] : ''
  const cli = r['driver'] === 'cli' || r['name'] === 'cli-review'
  return run && cli ? JSON.stringify([r['kind'], r['name'], r['project'], run]) : ''
}

/** @param {Record<string, unknown>} r */
const stopped = r => String(r['verdict'] ?? '').startsWith('INCOMPLETE')

/**
 * Every part's usable cost summed onto the standing part's; the parts whose cost is not usable counted as skipped.
 * @param {Record<string, unknown>[]} parts  the standing part first @returns {unknown}
 */
function summedCost(parts) {
  const usable = parts.map(p => /** @type {RecordCost} */ (p['cost'])).filter(c => costProblem(c) === null)
  if (!usable.length) return parts[0]?.['cost']
  /** @type {Record<string, unknown>} */
  const sum = { ...usable[0] }
  for (const k of COUNTS) sum[k] = usable.reduce((n, c) => n + (Number(c[k]) || 0), 0)
  sum['total'] = usable.reduce((n, c) => n + costTotal(c), 0)
  const skipped = usable.reduce((n, c) => n + (Number(c.skipped) || 0), 0) + parts.length - usable.length
  return skipped ? { ...sum, skipped } : sum
}

/** @param {Record<string, unknown>[]} parts  the standing part first */
function summedTokens(parts) {
  const head = parts[0]?.['outputTokens']
  if (typeof head !== 'number') return head
  return parts.reduce((n, p) => n + (typeof p['outputTokens'] === 'number' ? p['outputTokens'] : 0), 0)
}

/**
 * The part that stands for a run: its newest finished record, else its newest.
 * @template {Record<string, unknown>} R @param {R[]} parts @returns {R}
 */
function standingOf(parts) {
  const newest = (/** @type {R[]} */ rs) => rs.reduce((a, b) => (String(b['ts'] ?? '') > String(a['ts'] ?? '') ? b : a))
  const done = parts.filter(p => !stopped(p))
  return newest(done.length ? done : parts)
}

/**
 * `records` with each run's parts folded into the one standing for it, and how many were folded; a run filed once is
 * kept as it stands.
 * @template {Record<string, unknown>} R @param {R[]} records @returns {{ records: R[], folded: number }}
 */
export function foldStoppedParts(records) {
  /** @type {Map<string, R[]>} */
  const runs = new Map()
  /** @type {R[]} */
  const kept = []
  for (const r of records) {
    const key = partKey(r)
    if (!key) kept.push(r)
    else runs.set(key, [...(runs.get(key) ?? []), r])
  }
  let folded = 0
  for (const parts of runs.values()) {
    const standing = standingOf(parts)
    // Only a stopped part folds: two finished records of one run are a re-filing, which foldResumedRuns judges.
    const folding = parts.filter(p => p !== standing && stopped(p))
    const rest = parts.filter(p => p !== standing && !stopped(p))
    folded += folding.length
    if (!folding.length) kept.push(...parts)
    else {
      const all = [standing, ...folding]
      kept.push({ ...standing, cost: summedCost(all), outputTokens: summedTokens(all) }, ...rest)
    }
  }
  return { records: kept, folded }
}
