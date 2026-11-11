// Which arguments the review driver (lib/cli-review-steps.mjs) takes, and the ones a launcher of the JS review
// passes that it refuses rather than ignores: a run told to do what the binary does not do would report a review
// nobody asked for. Also the launch options a parent engine or a caller of review passes on — the optional pass
// (`optional`, as lib/review-lens-tallies.mjs's parseOptionalRequest reads it), the parent's name (`_via`) and its own
// recall (`_recalled`). A refusal is filed as the engines file theirs (realm @nick/craft, nodes #159, #411): an
// INCOMPLETE record whose `notRun` names the refusal's class.
import { shq } from './plugin-script.mjs'
import { REPO_REFUSED_CLASS } from './repo-arg.mjs'
import { UNKNOWN_OPTION_CLASS, unknownOptionsRefusal } from './workflow-args.mjs'

// The class a value the driver cannot use files in `notRun`, without the value (ranked by exact string).
export const VALUE_REFUSED_CLASS = 'an argument value review cannot use was refused, nothing ran'

/** Every argument the driver takes. */
const TAKEN = [
  'repo',
  'base',
  'depth',
  'craftBin',
  'craftRoot',
  'fresh',
  'fullEvery',
  'strict',
  'gate',
  'priorDecisions',
  'extraLenses',
  'unitScope',
  'path',
  'comment',
  'run',
  'optional',
  '_via',
  '_recalled',
  'gateOnly',
  'gateFrom',
  'pr',
]

// The JS review's unit-mode batching knobs: the binary batches unit mode's lenses itself.
const UNIT_KNOB = "the binary chooses unit mode's batches itself (unitScope=true)"
// A parent's recall handed on in the JS review's own shape.
const RECALL_PART = "the binary reads a launcher's recall only as records: pass them as priorDecisions, with _recalled=true"

/** The JS review's arguments the driver refuses, each with why. @type {Record<string, string>} */
const NOT_TAKEN = {
  languages: 'each changed file goes to its profile (Rust, Nix, general); narrow with path=',
  deadlineMs: 'the binary keeps no per-phase deadline table',
  unitBatches: UNIT_KNOB,
  unitBatchBudget: UNIT_KNOB,
  unitAgentCeiling: UNIT_KNOB,
  costModel: UNIT_KNOB,
  files: 'the change is read from git: narrow it with path= or base=',
  batch: 'the change is read from git: narrow it with path= or base=',
  maxRetries: 'the binary decides how often a task is asked again',
  _memory: RECALL_PART,
  _memoryParts: RECALL_PART,
  _externals: RECALL_PART,
  _knownExternals: RECALL_PART,
}

/**
 * Why the arguments of `a` the driver does not take are refused, '' when it takes every one: each of the JS review's
 * with its reason, the rest as every engine refuses an unknown option (lib/workflow-args.mjs).
 * @param {Record<string, unknown>} a @returns {string}
 */
function refusedKeys(a) {
  const known = Object.keys(a).filter(k => Object.hasOwn(NOT_TAKEN, k))
  const named = known.map(k => `review cannot honour \`${k}\`: ${NOT_TAKEN[k]}.`)
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !known.includes(k)))
  const unknown = unknownOptionsRefusal(rest, TAKEN, 'review')
  return [...named, unknown || (named.length ? 'Nothing ran.' : '')].filter(Boolean).join(' ')
}

/** The arguments only a start reads: the binary keeps them in the run's state, and a resume (`run`) takes none. */
const START_ONLY = [
  'base',
  'depth',
  'fresh',
  'fullEvery',
  'strict',
  'gate',
  'priorDecisions',
  'extraLenses',
  'unitScope',
  'path',
  'comment',
  'optional',
  '_recalled',
  'gateFrom',
]

/**
 * Why `a` gives start options beside `run`, '' when it does not: the resumed run goes on with the options it started
 * with, so one given now would be silently ignored. `comment=true` alone is taken: it publishes a finished run's
 * findings on its PR after the fact (`craft review comment`; realm @nick/craft, node #270).
 * @param {Record<string, unknown>} a @returns {string}
 */
function startOnlyBesideRun(a) {
  const given = a['run'] == null ? [] : START_ONLY.filter(k => a[k] !== undefined && !(k === 'comment' && a[k] === true))
  return given.length
    ? `review cannot honour ${given.map(k => `\`${k}\``).join(', ')} beside run=: a resumed run goes on with the options it was started with, fixed in its state (only comment=true is taken beside it, to publish a finished run's findings). Drop them to resume it, or start a new review to change them. Nothing ran.`
    : ''
}

/**
 * Why `a` gives `gateOnly` with an option it cannot honour, '' when it does not: the gate alone (`craft review gate`)
 * reads only the change and its base, opens no run and runs no lens, so any other review option, a run to resume or a
 * pull request (whose head keys a chain the gate opens none of) would be silently ignored; a value that is not true or
 * false is refused too.
 * @param {Record<string, unknown>} a @returns {string}
 */
function gateOnlyBeside(a) {
  const v = a['gateOnly']
  if (v === undefined || v === false) return ''
  if (v !== true) return `review: gateOnly=${JSON.stringify(v)} is not true or false. Nothing ran.`
  const given = [...START_ONLY.filter(k => k !== 'base'), 'run', 'pr'].filter(k => a[k] !== undefined)
  return given.length
    ? `review cannot honour ${given.map(k => `\`${k}\``).join(', ')} beside gateOnly=true: the gate alone reads only the change against its base and runs no review. Nothing ran.`
    : ''
}

/**
 * Why `a` gives `pr` beside run= without comment=true, '' when it does not: beside run= it names the pull request a
 * finished run's findings are published on (`craft review comment --pr`); on a start, the pull request under review,
 * whose head branch keys a detached HEAD's chain of rounds (`craft review start --pr`); and it is a PR's number.
 * @param {Record<string, unknown>} a @returns {string}
 */
function prBeside(a) {
  const v = a['pr']
  if (v === undefined) return ''
  if (a['run'] != null && a['comment'] !== true)
    return "review cannot honour `pr` beside run= without comment=true: pr= there names the pull request a finished run's findings are published on. Nothing ran."
  return /^[1-9][0-9]{0,9}$/.test(String(v)) ? '' : `review: pr=${JSON.stringify(v)} is not a pull request number. Nothing ran.`
}

/**
 * Why `a` gives `gateFrom` with `gate=false`, '' when it does not: one takes a gate, the other asks for none.
 * @param {Record<string, unknown>} a @returns {string}
 */
const gateFromBeside = a =>
  a['gateFrom'] != null && a['gate'] === false
    ? "review cannot honour `gateFrom` beside gate=false: one takes the launching run's gate, the other asks for no gate. Nothing ran."
    : ''

/**
 * Why `a` cannot be used and the class its record files, null when it can: the arguments not taken first, then start
 * options beside `run` or `gateOnly`, then the first value `readValues` refuses (a `repo` an agent cannot \`cd\` to is the engines'
 * own class).
 * @param {Record<string, unknown>} a @param {(a: Record<string, unknown>) => { refused: string } | object} readValues
 * @returns {{ why: string, cls: string } | null}
 */
export function argumentProblem(a, readValues) {
  const keys = refusedKeys(a)
  if (keys) return { why: keys, cls: UNKNOWN_OPTION_CLASS }
  const fixed = startOnlyBesideRun(a) || gateOnlyBeside(a) || gateFromBeside(a) || prBeside(a)
  if (fixed) return { why: fixed, cls: VALUE_REFUSED_CLASS }
  const read = readValues(a)
  if (!('refused' in read)) return null
  return { why: `review: ${read.refused}. Nothing ran.`, cls: /^repo=/.test(read.refused) ? REPO_REFUSED_CLASS : VALUE_REFUSED_CLASS }
}

/** The parent engine's name `_via` gives, '' when absent, null when it is no engine name. @param {unknown} v @returns {string | null} */
export const viaName = v => (v == null ? '' : typeof v === 'string' && /^[\w.:-]{0,64}$/.test(v) ? v : null)

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
 * the binary's `--no-recall`).
 * @param {Record<string, unknown>} a @returns {{ optional: string, via: string, recalled: boolean } | { refused: string }}
 */
export function launchOptions(a) {
  const opt = optionalOption(a['optional'])
  if ('refused' in opt) return opt
  const via = viaName(a['_via'])
  if (via === null) return { refused: `_via=${JSON.stringify(a['_via'])} is not an engine name` }
  const recalled = a['_recalled'] ?? false
  if (recalled !== true && recalled !== false) return { refused: `_recalled=${JSON.stringify(recalled)} is not true or false` }
  return { ...opt, via, recalled }
}

/**
 * The start's flags for the launch options: `--optional` with its text, `--no-recall` when the launcher recalled, and
 * `--nested` under a parent engine, so the run builds on no round of the branch's chain and files none, as the engine
 * keeps a nested review out of it (selectPriorRounds, lib/run-record.mjs).
 * @param {{ optional: string, recalled: boolean, via: string }} o @returns {string}
 */
export const launchFlags = o => `${o.optional ? ` --optional ${shq(o.optional)}` : ''}${o.recalled ? ' --no-recall' : ''}${o.via ? ' --nested' : ''}`
