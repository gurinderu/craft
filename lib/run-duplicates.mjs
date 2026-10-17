// Records of ONE run counted once (realm @nick/craft, node #249).
//
// Resuming a workflow with a changed argument (posting findings to the PR, say) re-runs every step
// whose prompt changed, and `finalize` files a second record of the same run: the same findings, a
// cumulative `outputTokens`. Counted twice, every rate and the cost are skewed. A record carries no
// run id, so identity is everything a resume keeps and a separate run would not: the engine build,
// project, head, diff digest, round, the run's own settings (base, path, strict, nested, dirty, scope,
// intent and spec digests) and its findings by severity — an independent run of the same diff almost
// never lands the same counts. The newest stands for the run. A record missing its head or its digest
// proves no identity and is never folded; a died run (`partial`) is never folded into a finished one.

import { engineKey } from './run-record.mjs'

// The run's own settings a resume carries unchanged.
const KEPT = ['partial', 'base', 'path', 'strict', 'nested', 'dirty', 'lensScope', 'intentDigest', 'specDigest']

/** @param {Record<string, unknown>} r @returns {string} */
function runKey(r) {
  const head = String(r['head'] || r['commit'] || '')
  const digest = String(r['filesDigest'] || '')
  if (!head || !digest) return ''
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
