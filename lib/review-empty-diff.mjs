// The report of an empty diff (lib/review-coverage-phase.mjs): whether it is a launch on the trunk itself, its
// message and its Detected line.
import { baseIsHead, noChangedFilesMessage, onTrunkMessage } from './review-coverage.mjs'

/** @typedef {import('./review-schemas.mjs').DetectAnswer} DetectAnswer */

/**
 * The empty diff's message and Detected line. Whether it is a launch on the trunk: the agent's own rev-parse comparison
 * first, the sha test the fallback when it answered none. An explicit `base` equal to HEAD is the caller's choice, not
 * a launch on the trunk (realm @nick/craft, node #251).
 * @param {{ baseArg: string, detected: DetectAnswer, baseRef: string, head: string, branch: string }} at
 * @returns {{ msg: string, detectedLine: string }}
 */
export function emptyDiffReport({ baseArg, detected, baseRef, head, branch }) {
  const onTrunk = !baseArg && (detected?.baseIsHead === true || baseIsHead(baseRef || '', head))
  if (onTrunk) return { msg: onTrunkMessage(), detectedLine: `HEAD ${head}${branch ? ` on \`${branch}\`` : ''} is the base itself (${baseRef}): 0 changed file(s)` }
  return { msg: noChangedFilesMessage(), detectedLine: detected?.notes || `0 changed file(s) against ${baseRef || 'HEAD'}` }
}
