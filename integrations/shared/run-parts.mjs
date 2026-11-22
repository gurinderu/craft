// A CLI run stopped and resumed files a record per part: the part its host stopped driving files INCOMPLETE, the
// resume's part files the run's verdict, and each names the binary's run directory (`cliRun`). Counted once, as the
// binary's `craft runs` readers count it (cli/crates/craft-store/src/parts.rs): a stopped part of a run that also
// filed a finished record folds into it, the finished record standing for the run; a run whose every part stopped
// stands as its newest. A part is mostly its own Workflow run with its own cost, so the standing record carries the
// sum of every Workflow run's share once (by the cost's `source` and slice; a repeated share is the latest part's) and
// how many shares carry no usable cost as `partsUnmeasured`, which with a share's own `skipped` makes the run's cost
// partial (run-record.mjs, costProblem), never averaged in as whole. `outputTokens` is never summed: it is the turn's
// shared pool while a part ran, indicative only (on a record without `outputTokensScope: 'turn-delta'`, the session's running total), so the
// standing record keeps its own. The fold runs before
// any version or engine slice: the run is counted under its standing record's version, and a slice of the stopped
// part's version says it folded. A record that names no run directory, filed before records named it, folds on
// nothing here.
import { costProblem, costSlice, costTotal } from './run-record.mjs'

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

/** @param {unknown} c @returns {string} */
const sourceOf = c =>
  c && typeof c === 'object' && typeof (/** @type {{ source?: unknown }} */ (c).source) === 'string' ? /** @type {{ source: string }} */ (c).source : ''

/**
 * One part per share of spend: parts whose `keyOf` repeats are the same Workflow run's spend filed twice (a phantom
 * INCOMPLETE beside its finished record, a replay whose pool is cumulative), the latest part's kept; a part with no
 * key is a share of its own.
 * @param {Record<string, unknown>[]} parts @param {(p: Record<string, unknown>) => string} keyOf
 */
function perShare(parts, keyOf) {
  const byTime = [...parts].sort((a, b) => (String(a['ts'] ?? '') < String(b['ts'] ?? '') ? -1 : 1))
  /** @type {Map<string, Record<string, unknown>>} */
  const shares = new Map()
  byTime.forEach((p, i) => shares.set(keyOf(p) || `#${String(i)}`, p))
  return [...shares.values()]
}

/** A cost's share of its Workflow run: the run, and the slice of it enrich-cost gave this record. @param {Record<string, unknown>} p */
function costShare(p) {
  const source = sourceOf(p['cost'])
  const slice = source ? costSlice(/** @type {RecordCost} */ (p['cost']).slice) : null
  return source ? `${source}#${slice ? String(slice.index) : ''}` : ''
}

/**
 * Every share's usable cost summed onto the standing part's, once per Workflow run and slice; how many shares carry no
 * usable cost is `partsUnmeasured`.
 * @param {Record<string, unknown>[]} parts  the standing part first @returns {unknown}
 */
function summedCost(parts) {
  const shares = perShare(parts, costShare)
  // A partial cost is a measured lower bound: its share is summed and its `skipped` carried, so the sum is partial too.
  const counted = (/** @type {RecordCost} */ c) => [null, 'partial'].includes(costProblem(c))
  const usable = shares.map(p => /** @type {RecordCost} */ (p['cost'])).filter(counted)
  const own = /** @type {RecordCost} */ (parts[0]?.['cost'])
  if (!usable.length) return own
  /** @type {Record<string, unknown>} */
  const sum = { ...(counted(own) ? own : usable[0]) }
  for (const k of COUNTS) sum[k] = usable.reduce((n, c) => n + (Number(c[k]) || 0), 0)
  sum['total'] = usable.reduce((n, c) => n + costTotal(c), 0)
  const skipped = usable.reduce((n, c) => n + (Number(c.skipped) || 0), 0)
  if (skipped) sum['skipped'] = skipped
  else delete sum['skipped']
  const unmeasured = shares.length - usable.length
  return unmeasured ? { ...sum, partsUnmeasured: unmeasured } : sum
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
 * `records` with each run's parts folded into the one standing for it, how many were folded and which (`parts`, for a
 * slice to count its own); a run filed once is kept as it stands.
 * @template {Record<string, unknown>} R @param {R[]} records @returns {{ records: R[], folded: number, parts: R[] }}
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
  /** @type {R[]} */
  const gone = []
  for (const parts of runs.values()) {
    const standing = standingOf(parts)
    // Only a stopped part folds: two finished records of one run are a re-filing, which foldResumedRuns judges.
    const folding = parts.filter(p => p !== standing && stopped(p))
    const rest = parts.filter(p => p !== standing && !stopped(p))
    gone.push(...folding)
    if (!folding.length) kept.push(...parts)
    else {
      const all = [standing, ...folding]
      kept.push({ ...standing, cost: summedCost(all) }, ...rest)
    }
  }
  return { records: kept, folded: gone.length, parts: gone }
}
