// The severity floor for controller findings on a deletion or recovery path (realm @nick/craft,
// nodes #298, #299). The reconciler and failure-windows lenses flag such a finding with
// `deletionOrRecoveryPath`; one filed below Medium is raised to Medium BEFORE dedup and verification
// routing, so it is verified, counted by the verdict code and recorded at the severity it is reported
// at. The floor is not final: the reach demotion after verification (a verifier judging the code
// unreachable in production) still lowers it one notch. Lives here, outside the workflow, and is
// pasted back into src/review.js through a `craft-inline` fenced region.

/** The lenses whose flag the floor honours: the ones that read the distributed-races catalogue. */
export const PATH_FLOOR_LENSES = ['reconciler', 'failure-windows']

/**
 * `f` raised to Medium when a catalogue lens flagged it on a deletion or recovery path below Medium;
 * otherwise `f` unchanged.
 * @template {{ severity?: string, source?: string, why?: string, deletionOrRecoveryPath?: boolean }} F
 * @param {F} f
 * @returns {F}
 */
export function raisePathFloor(f) {
  if (f.deletionOrRecoveryPath !== true) return f
  if (!PATH_FLOOR_LENSES.includes(String(f.source ?? ''))) return f
  if (f.severity !== 'Low' && f.severity !== 'Info') return f
  return { ...f, severity: 'Medium', why: `${f.why ?? ''} (raised to Medium from ${f.severity}: deletion/recovery-path floor (R16-R20 catalogue); a verifier judging it unreachable in production can still lower it)` }
}

/**
 * Every finding of a pool through the floor.
 * @template {{ severity?: string, source?: string, why?: string, deletionOrRecoveryPath?: boolean }} F
 * @param {F[]} pool
 * @returns {F[]}
 */
export function applyPathFloor(pool) {
  return pool.map(raisePathFloor)
}
