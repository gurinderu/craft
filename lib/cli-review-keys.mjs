// Which arguments the cli-review driver (lib/cli-review-steps.mjs) takes, and the ones a launcher of the JS review
// passes that it refuses rather than ignores: a run told to do what the binary does not do would report a review
// nobody asked for. Also the launch options a parent engine or a caller of review passes on — the optional pass
// (`optional`, as lib/review-lens-tallies.mjs's parseOptionalRequest reads it), the parent's name (`_via`) and its own
// recall (`_recalled`).
import { shq } from './plugin-script.mjs'

/** Every argument the driver takes. */
const TAKEN = [
  'repo', 'base', 'depth', 'craftBin', 'craftRoot', 'fresh', 'fullEvery', 'strict', 'gate', 'priorDecisions',
  'extraLenses', 'unitScope', 'path', 'comment', 'run', 'optional', '_via', '_recalled',
]

// The JS review's unit-mode batching knobs: the binary batches unit mode's lenses itself.
const UNIT_KNOB = 'the binary chooses unit mode\'s batches itself (unitScope=true)'
// A parent's recall handed on in the JS review's own shape.
const RECALL_PART = 'the binary reads a launcher\'s recall only as records: pass them as priorDecisions, with _recalled=true'

/** The JS review's arguments the driver refuses, each with why. @type {Record<string, string>} */
const NOT_TAKEN = {
  languages: 'each changed file goes to its profile (Rust, Nix, general); narrow with path=',
  deadlineMs: 'the binary keeps no per-phase deadline table',
  unitBatches: UNIT_KNOB, unitBatchBudget: UNIT_KNOB, unitAgentCeiling: UNIT_KNOB, costModel: UNIT_KNOB,
  files: 'the change is read from git: narrow it with path= or base=',
  batch: 'the change is read from git: narrow it with path= or base=',
  maxRetries: 'the binary decides how often a task is asked again',
  _memory: RECALL_PART, _memoryParts: RECALL_PART, _externals: RECALL_PART, _knownExternals: RECALL_PART,
}

/**
 * Why an argument of `a` is refused, '' when every one is taken.
 * @param {Record<string, unknown>} a @returns {string}
 */
function refusedKey(a) {
  for (const k of Object.keys(a)) {
    if (TAKEN.includes(k)) continue
    const why = Object.hasOwn(NOT_TAKEN, k) ? NOT_TAKEN[k] : `it is no option of cli-review, which takes ${TAKEN.join(', ')}`
    return `${k}= is not taken: ${why}`
  }
  return ''
}

/** Whether `s` holds a control character. @param {string} s */
export const hasControl = s => [...s].some(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

// The values that buy no optional lens, and those that buy the whole set, as parseOptionalRequest reads them.
/** @type {unknown[]} */
const OPTIONAL_NONE = [undefined, null, '', false, 'false', 'none']
/** @type {unknown[]} */
const OPTIONAL_ALL = [true, 'true', 'all']

/**
 * The optional pass as `--optional` takes it: `all`, the names joined by commas, '' for none. The binary reads the
 * names and notes one that is no optional lens in the report, the recognised ones still run.
 * @param {unknown} v @returns {{ optional: string } | { refused: string }}
 */
function optionalOption(v) {
  if (OPTIONAL_NONE.includes(v)) return { optional: '' }
  if (OPTIONAL_ALL.includes(v)) return { optional: 'all' }
  const names = Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : v
  if (typeof names !== 'string' || hasControl(names)) return { refused: `optional=${JSON.stringify(v)} is not true, all or a list of lens names` }
  return { optional: names.trim() }
}

/**
 * The launch options beside the review's own: the optional pass, the parent engine that launched this run (`_via`, the
 * record then filed nested under it) and whether that launcher recalled the project's memory itself (`_recalled`,
 * the binary's `--no-recall`); first, any argument the driver does not take refused.
 * @param {Record<string, unknown>} a @returns {{ optional: string, via: string, recalled: boolean } | { refused: string }}
 */
export function launchOptions(a) {
  const key = refusedKey(a)
  if (key) return { refused: key }
  const opt = optionalOption(a['optional'])
  if ('refused' in opt) return opt
  const via = a['_via'] ?? ''
  if (typeof via !== 'string' || !/^[\w.:-]{0,64}$/.test(via)) return { refused: `_via=${JSON.stringify(via)} is not an engine name` }
  const recalled = a['_recalled'] ?? false
  if (recalled !== true && recalled !== false) return { refused: `_recalled=${JSON.stringify(recalled)} is not true or false` }
  return { ...opt, via, recalled }
}

/**
 * The start's flags for the launch options: `--optional` with its text, `--no-recall` when the launcher recalled.
 * @param {{ optional: string, recalled: boolean }} o @returns {string}
 */
export const launchFlags = o => `${o.optional ? ` --optional ${shq(o.optional)}` : ''}${o.recalled ? ' --no-recall' : ''}`
