// Records of ONE run counted once (realm @nick/craft, node #249).
//
// Resuming a workflow with a changed argument (posting findings to the PR, say) re-runs every step
// whose prompt changed, and `finalize` files a second record of the same run: the same findings, a
// cumulative `outputTokens`. Counted twice, every rate and the cost are skewed. A record carries no
// run id, so identity is everything a resume keeps and a separate run would not: the engine build,
// project, head, the digest of the changed-file set (`filesDigest` — names, not content), round and why
// it has that number (a `fresh` round 1 is a new run), the run's own settings (base, path, strict, dirty, scope, intent and spec digests, crateScope) and its findings by
// severity. The newest stands for the run. Never folded, because their identity is too weak: a record
// missing its head or digest; a died run (`partial`); a nested per-crate review and a record with no
// branch, whose round never advances; a run that found nothing, since every clean run of one diff
// lands the same all-zero counts.

import { engineKey } from './run-record.mjs'

// The run's own settings a resume carries unchanged.
const KEPT = ['base', 'path', 'strict', 'dirty', 'lensScope', 'intentDigest', 'specDigest', 'crateScope']

/** @param {Record<string, unknown>} r @returns {{ total?: unknown, bySeverity?: unknown }} */
function findingsOf(r) {
  const f = r['findings']
  return f && typeof f === 'object' ? f : {}
}

// Why the round has the number it has: a `fresh` re-run of round 1 is a new run, not a resume.
/** @param {Record<string, unknown>} r @returns {unknown} */
function reReviewReason(r) {
  const rr = r['reReview']
  return rr && typeof rr === 'object' ? /** @type {{ reason?: unknown }} */ (rr).reason ?? null : null
}

// Whether a record's identity is strong enough to fold on at all.
/** @param {Record<string, unknown>} r @param {string} head @returns {boolean} */
function foldable(r, head) {
  return Boolean(head && r['filesDigest'] && r['branch'] && !r['nested'] && !r['partial'] && Number(findingsOf(r).total || 0))
}

/** @param {Record<string, unknown>} r @returns {string} */
function runKey(r) {
  const head = String(r['head'] || r['commit'] || '')
  if (!foldable(r, head)) return ''
  return JSON.stringify([engineKey(r), r['kind'], r['name'], r['project'], head, r['filesDigest'], r['round'] ?? null,
    ...KEPT.map(k => r[k] ?? null), reReviewReason(r), findingsOf(r).bySeverity ?? null])
}

/**
 * @template {Record<string, unknown>} R
 * @param {R[]} records
 * @returns {{ records: R[], folded: number }}
 */
export function foldResumedRuns(records) {
  /** @type {Map<string, R>} */
  const newest = new Map()
  /** @type {R[]} */
  const kept = []
  let folded = 0
  for (const r of records) {
    const key = runKey(r)
    if (!key) { kept.push(r); continue }
    const seen = newest.get(key)
    if (seen) folded++
    if (!seen || String(r['ts'] || '') > String(seen['ts'] || '')) newest.set(key, r)
  }
  return { records: [...kept, ...newest.values()], folded }
}
