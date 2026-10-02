// The form of lib/mutation-floor.json: the weekly Stryker run's floor (`break`) and what it is measured over
// (`mutate`). Its own module, not the checker's: stryker.config.mjs reads it, and the checker imports that
// config — were the parser in the checker, running the checker would import itself through the config.
import { parseJsonObject } from './json-object.mjs'

export const FLOOR_FILE = 'lib/mutation-floor.json'

/** @typedef {{ break: number, mutate: string[] }} Floor */

/** @param {string} glob @returns {boolean} */
export const isExclusion = (glob) => glob.startsWith('!')

/** @param {unknown} v @returns {v is number} 0 to 100, both ends included; NaN and ±Infinity fall outside the range */
const isPercentage = (v) => typeof v === 'number' && v >= 0 && v <= 100

/**
 * Stryker applies `mutate` in order: an exclusion unmarks the files marked before it, and an include after it
 * marks them again. So the includes come first and every exclusion after them — then the measured set is the
 * includes minus the exclusions whatever their order, and comparing the globs as sets is sound.
 * @param {unknown} v @returns {v is string[]} at least one including glob, then only `!` exclusions, if any
 */
function isMutate(v) {
  if (!Array.isArray(v) || !v.every((g) => typeof g === 'string' && g.length > 0)) return false
  const globs = /** @type {string[]} */ (v)
  const lastInclude = globs.findLastIndex((g) => !isExclusion(g))
  return lastInclude >= 0 && !globs.slice(0, lastInclude).some(isExclusion)
}

/**
 * @param {string} text  the floor file's contents
 * @returns {Floor}
 * @throws {Error} naming the file, when it is not `{ "break": <0..100>, "mutate": [<include>, …, <!exclusion>, …] }`
 */
export function parseFloor(text) {
  /** @type {Record<string, unknown>} */
  let o = {}
  try { o = parseJsonObject(text) } catch { /* reported below as the wrong form */ }
  const floor = o['break']
  const mutate = o['mutate']
  if (!isPercentage(floor) || !isMutate(mutate)) {
    throw new Error(`${FLOOR_FILE} must be { "break": <a percentage, 0 to 100>, "mutate": [<a glob to include>, …, <a "!" exclusion after them all>, …] }`)
  }
  return { break: floor, mutate }
}
