// The severity floor for controller findings on a deletion or recovery path (realm @nick/craft,
// nodes #298, #299). The reconciler and failure-windows lenses flag such a finding with
// `deletionOrRecoveryPath`; one filed below Medium is raised to Medium BEFORE dedup and verification
// routing, so it is verified, counted by the verdict code and recorded at the severity it is reported
// at. The floor is not final: the reach demotion after verification (a verifier judging the code
// unreachable in production) still lowers it one notch. It honours only a finding that names a harm
// of operator recovery or worse, read as the cap reads it (a `repo-rule` citing no rule is `none`): a
// floor does not invent a harm (realm @nick/craft, node #379). Lives here, outside the workflow, and
// src/review.js imports it.
import { harmAtLeastOperatorRecovery } from './harm-levels.mjs'
import { effectiveLevel } from './harm-cap.mjs'

/** The lenses whose flag the floor honours: the ones that read the distributed-races catalogue. */
export const PATH_FLOOR_LENSES = ['reconciler', 'failure-windows']

/** The words the floor's note carries, which synthesis is told not to calibrate below Medium. */
export const PATH_FLOOR_MARK = 'deletion/recovery-path floor'

/**
 * The floor's note as `raisePathFloor` writes it, built from the same mark.
 * @returns {RegExp}
 */
export function pathFloorNoteRe() {
  return new RegExp(` \\(raised to Medium from \\w+: ${PATH_FLOOR_MARK} \\(R16-R20 catalogue\\); [^\\x29]*\\)`)
}

/**
 * `f` raised to Medium when a catalogue lens flagged it on a deletion or recovery path below Medium
 * and it names a harm of operator recovery or worse; otherwise `f` unchanged.
 * @template {{ severity?: string, source?: string, why?: string, deletionOrRecoveryPath?: boolean, harmLevel?: string, repoRule?: unknown }} F
 * @param {F} f
 * @returns {F}
 */
export function raisePathFloor(f) {
  if (f.deletionOrRecoveryPath !== true) return f
  if (!PATH_FLOOR_LENSES.includes(String(f.source ?? ''))) return f
  if (f.severity !== 'Low' && f.severity !== 'Info') return f
  if (!harmAtLeastOperatorRecovery(effectiveLevel(f))) return f
  return { ...f, severity: 'Medium', why: `${f.why ?? ''} (raised to Medium from ${f.severity}: ${PATH_FLOOR_MARK} (R16-R20 catalogue); a verifier judging it unreachable in production can still lower it)` }
}

/**
 * The floor's note carried by `why`, or '' when the finding was not raised by the floor.
 * @param {unknown} why
 * @returns {string}
 */
export function pathFloorNote(why) {
  const m = pathFloorNoteRe().exec(String(why ?? ''))
  return m ? m[0] : ''
}

/**
 * `why` without the floor's note: once the reach demotion lowers a floored finding, the note's
 * claim that it stands at Medium is no longer true.
 * @param {unknown} why
 * @returns {string}
 */
export function withoutPathFloorNote(why) {
  return String(why ?? '').replace(pathFloorNoteRe(), '')
}

/**
 * Every finding of a pool through the floor.
 * @template {{ severity?: string, source?: string, why?: string, deletionOrRecoveryPath?: boolean, harmLevel?: string, repoRule?: unknown }} F
 * @param {F[]} pool
 * @returns {F[]}
 */
export function applyPathFloor(pool) {
  return pool.map(raisePathFloor)
}
