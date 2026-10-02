// The form of lib/mutation-floor.json: the weekly Stryker run's floor (`break`) and what it is measured over
// (`mutate`). Its own module, not the checker's: stryker.config.mjs reads it, and the checker imports that
// config — were the parser in the checker, running the checker would import itself through the config.
import { parseJsonObject } from './json-object.mjs'

export const FLOOR_FILE = 'lib/mutation-floor.json'

/** @typedef {{ break: number, mutate: string[] }} Floor */

/** @param {string} glob @returns {boolean} */
export const isExclusion = (glob) => glob.startsWith('!')

/** @param {unknown} v @returns {v is number} */
const isPercentage = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100

/** @param {unknown} v @returns {v is string[]} a list of globs, at least one of them including */
function isMutate(v) {
  if (!Array.isArray(v) || !v.every((g) => typeof g === 'string' && g.length > 0)) return false
  return /** @type {string[]} */ (v).some((g) => !isExclusion(g))
}

/**
 * @param {string} text  the floor file's contents
 * @returns {Floor}
 * @throws {Error} naming the file, when it is not `{ "break": <0..100>, "mutate": [<glob>, …] }`
 */
export function parseFloor(text) {
  /** @type {Record<string, unknown>} */
  let o = {}
  try { o = parseJsonObject(text) } catch { /* reported below as the wrong form */ }
  const floor = o['break']
  const mutate = o['mutate']
  if (!isPercentage(floor) || !isMutate(mutate)) {
    throw new Error(`${FLOOR_FILE} must be { "break": <a percentage, 0 to 100>, "mutate": [<a glob to include>, …] }`)
  }
  return { break: floor, mutate }
}
