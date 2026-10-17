// Records of ONE run counted once (realm @nick/craft, node #249).
//
// Resuming a workflow with a changed argument (posting findings to the PR, say) re-runs every step
// whose prompt changed, and `finalize` files a second record of the same run: the same findings, a
// cumulative `outputTokens`. Counted twice, every rate and the cost are skewed. A record carries no
// run id, so identity is everything a resume keeps and a separate run would not: the engine build,
// project, head, the digest of the changed-file set (`filesDigest` — names, not content), round, the
// run's own settings (base, path, strict, dirty, scope, intent and spec digests) and its findings by
// severity. The newest stands for the run. Never folded, because their identity is too weak: a record
// missing its head or digest; a died run (`partial`); a nested per-crate review and a record with no
// branch, whose round never advances; a run that found nothing, since every clean run of one diff
// lands the same all-zero counts.

import { engineKey } from './run-record.mjs'

// The run's own settings a resume carries unchanged.
const KEPT = ['partial', 'base', 'path', 'strict', 'dirty', 'lensScope', 'intentDigest', 'specDigest']

/** @param {Record<string, unknown>} r @returns {string} */
function runKey(r) {
  const head = String(r['head'] || r['commit'] || '')
  const digest = String(r['filesDigest'] || '')
  if (!head || !digest || r['nested'] || !r['branch']) return ''
  if (!Number((r['findings'] && /** @type {{ total?: unknown }} */ (r['findings']).total) || 0)) return ''
  return JSON.stringify([engineKey(r), r['kind'], r['name'], r['project'], head, digest, r['round'] ?? null,
    ...KEPT.map(k => r[k] ?? null), (r['findings'] && /** @type {{ bySeverity?: unknown }} */ (r['findings']).bySeverity) ?? null])
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
