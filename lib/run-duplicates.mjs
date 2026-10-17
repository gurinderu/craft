// Records of ONE run counted once (realm @nick/craft, node #249).
//
// Resuming a workflow with a changed argument (posting findings to the PR, say) re-runs every step
// whose prompt changed, and `finalize` files a second record of the same run: the same findings, a
// cumulative `outputTokens`. Counted twice, every rate and the cost are skewed. Records of one engine
// with the same project, head, diff digest and round are one run; the newest stands for it. A record
// missing its head or its digest proves no identity and is never folded.

/** @param {Record<string, unknown>} r @returns {string} */
function runKey(r) {
  const head = String(r['head'] || r['commit'] || '')
  const digest = String(r['filesDigest'] || '')
  if (!head || !digest) return ''
  return JSON.stringify([r['kind'], r['name'], r['project'], head, digest, r['round'] ?? null])
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
