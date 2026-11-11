// The review's options as the CLI's step-protocol driver for Claude Code reads them (lib/cli-review-steps.mjs; realm
// @nick/craft, node #453; the other hosts run the binary's own driver, #499): each argument checked and defaulted the
// one way, or refused with why. The binary decides the review by them; no driver interprets them further.
import { shellWord } from './plugin-script.mjs'
import { hasControl, launchOptions } from './cli-review-keys.mjs'
import { absolutePath } from './cli-review-step.mjs'

/** @typedef {{ repo: string, base: string, depth: string, craftBin: string | null, craftRoot: string, fresh: boolean, fullEvery: string, strict: boolean, gate: boolean, priorDecisions: string, extraLenses: string, unitScope: boolean, path: string, run: string, comment: boolean, optional: string, via: string, recalled: boolean, gateOnly: boolean, gateFrom: string, pr: string }} Options  pr: the pull request a finished run is published on (`run` with `comment`), or on a start the one under review, whose head branch keys a detached HEAD's chain; '' for the reviewed branch's; gateOnly: run the mechanical gate alone (`craft review gate`), no review; gateFrom: the directory of a gate run alone to take rather than run one ('' none); optional: the text of `--optional`, '' for none; via: the parent engine that launched the run, '' when none; recalled: the launcher recalled the memory itself (`--no-recall`); comment: publish the findings on the branch's PR; run the directory of a stopped or interrupted run to resume, '' to start one; craftBin shell-quoted, null until fetched; depth and fullEvery '' when not given; priorDecisions the JSON text of the launcher's list, '' when none; extraLenses the text of `--extra-lenses`, '' when not given; path the directory to review, '' for the whole change */

// The depths `craft review start --depth` takes.
const DEPTHS = new Set(['light', 'full'])

/** Why `a` names an option path that is not absolute, '' when none does. @param {Record<string, unknown>} a @returns {string} */
function badPath(a) {
  const bad = ['repo', 'craftBin', 'craftRoot', 'run', 'gateFrom'].find(k => a[k] != null && absolutePath(a[k]) === null)
  return bad ? `${bad}=${JSON.stringify(a[bad])} is not an absolute path` : ''
}

/** The base ref, '' when absent, null when it is no ref name. @param {unknown} v @returns {string | null} */
function refName(v) {
  if (v == null || v === '') return ''
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(v) ? v : null
}

/**
 * The round chain's arguments the binary takes: `fresh` (a new chain) and `fullEvery` (a whole-diff round every N),
 * or why they cannot be used. The binary decides which earlier round to build on and what to review.
 * @param {Record<string, unknown>} a @returns {{ fresh: boolean, fullEvery: string } | { refused: string }}
 */
function roundOptions(a) {
  const fresh = a['fresh'] ?? false
  if (fresh !== true && fresh !== false) return { refused: `fresh=${JSON.stringify(fresh)} is not true or false` }
  const every = a['fullEvery']
  if (every == null) return { fresh, fullEvery: '' }
  return Number.isInteger(every) && Number(every) >= 0 ? { fresh, fullEvery: String(every) } : { refused: `fullEvery=${JSON.stringify(every)} is not a whole number of rounds` }
}

/**
 * What the binary is told beyond the diff: `strict` (the maintainability bar a presumption of block), `gate` (false: no
 * mechanical gate, which builds and runs the branch's code — clippy's build scripts and proc macros, nix flake check — for a
 * branch not trusted) and the launcher's
 * own records, `priorDecisions`, as JSON text — the binary reads and refuses them as the engine does (a string, or any
 * value that is no list, is named and nothing of it applied), and adds them to what it recalls from the project's memory.
 * @param {Record<string, unknown>} a @returns {{ strict: boolean, gate: boolean, priorDecisions: string } | { refused: string }}
 */
function memoryOptions(a) {
  const strict = a['strict'] ?? false
  if (strict !== true && strict !== false) return { refused: `strict=${JSON.stringify(strict)} is not true or false` }
  const gate = a['gate'] ?? true
  if (gate !== true && gate !== false) return { refused: `gate=${JSON.stringify(gate)} is not true or false` }
  const given = a['priorDecisions']
  return { strict, gate, priorDecisions: given == null ? '' : JSON.stringify(given) }
}

/**
 * The consumer's own agents to run as extra lenses (`extraLenses`), as the text `--extra-lenses` takes: a list's
 * names joined by commas, a string as it stands, `off` for false or an empty list, '' when absent (the binary then
 * discovers them on a light pass). The binary reads and refuses the names; any other value is refused here.
 * @param {Record<string, unknown>} a @returns {{ extraLenses: string } | { refused: string }}
 */
function extraLensOption(a) {
  const v = a['extraLenses']
  if (v == null) return { extraLenses: '' }
  if (v === false || (Array.isArray(v) && !v.length)) return { extraLenses: 'off' }
  const names = Array.isArray(v) && v.every(x => typeof x === 'string') ? v.join(',') : v
  if (typeof names !== 'string' || hasControl(names)) return { refused: `extraLenses=${JSON.stringify(v)} is not a list of agent names` }
  return { extraLenses: names.trim() || 'off' }
}

/**
 * Unit mode (`unitScope`, off by default; realm @nick/craft, #362): passed through as `--unit-scope`; the binary
 * discovers the units, slices the change and says why when it cannot.
 * @param {Record<string, unknown>} a @returns {{ unitScope: boolean } | { refused: string }}
 */
function unitOption(a) {
  const unitScope = a['unitScope'] ?? false
  return unitScope === true || unitScope === false ? { unitScope } : { refused: `unitScope=${JSON.stringify(unitScope)} is not true or false` }
}

/**
 * The directory of the change to review (`path`, as rust-audit scopes a crate's review), passed through as `--path`;
 * the binary reads it repository-relative, or absolute inside the repository, and refuses one outside it.
 * @param {Record<string, unknown>} a @returns {{ path: string } | { refused: string }}
 */
function pathOption(a) {
  const v = a['path'] ?? ''
  return typeof v === 'string' && !hasControl(v) ? { path: v.trim() } : { refused: `path=${JSON.stringify(v)} is not a path` }
}

/**
 * Publishing on the PR (`comment`, off by default; realm @nick/craft, #194, #270): passed through as `--comment`; the
 * binary sorts the findings, posts the defects with gh itself and says what landed.
 * @param {Record<string, unknown>} a @returns {{ comment: boolean } | { refused: string }}
 */
function commentOption(a) {
  const comment = a['comment'] ?? false
  return comment === true || comment === false ? { comment } : { refused: `comment=${JSON.stringify(comment)} is not true or false` }
}

/**
 * The stopped or interrupted run to resume (`run`), '' to start one; a value that is no absolute path is refused by
 * badPath before this reads it. With it, the pull request a finished run is published on (`pr`, checked by
 * lib/cli-review-keys.mjs), '' when none is named.
 * @param {Record<string, unknown>} a @returns {{ run: string, pr: string }}
 */
const runOption = a => ({ run: absolutePath(a['run']) ?? '', pr: a['pr'] == null ? '' : String(a['pr']) })

/**
 * The gate alone (`gateOnly`), and a kept gate to take (`gateFrom`, checked absolute by badPath), whose values and
 * companions lib/cli-review-keys.mjs has checked.
 * @param {Record<string, unknown>} a @returns {{ gateOnly: boolean, gateFrom: string }}
 */
const gateOnlyOption = a => ({ gateOnly: a['gateOnly'] === true, gateFrom: absolutePath(a['gateFrom']) ?? '' })

/**
 * What the binary decides the review by beyond the diff and its base: the round chain's options, the memory's, the
 * extra lenses, unit mode, the scope, publishing on the PR, the run to resume and the launch options.
 * @param {Record<string, unknown>} a
 * @returns {Omit<Options, 'repo' | 'base' | 'depth' | 'craftBin' | 'craftRoot'> | { refused: string }}
 */
function reviewOptions(a) {
  /** @type {Array<Record<string, unknown>>} */
  const parts = []
  for (const read of [roundOptions, memoryOptions, extraLensOption, unitOption, pathOption, runOption, commentOption, launchOptions, gateOnlyOption]) {
    const got = read(a)
    if ('refused' in got) return got
    parts.push(got)
  }
  return /** @type {Omit<Options, 'repo' | 'base' | 'depth' | 'craftBin' | 'craftRoot'>} */ (Object.assign({}, ...parts))
}

/**
 * The run's options from `args`, or why they cannot be used.
 * @param {Record<string, unknown>} a @returns {{ options: Options } | { refused: string }}
 */
export function readOptions(a) {
  const refused = badPath(a)
  if (refused) return { refused }
  const base = refName(a['base'])
  if (base === null) return { refused: `base=${JSON.stringify(a['base'])} is not a ref name` }
  const depth = a['depth'] ?? ''
  if (depth !== '' && !DEPTHS.has(String(depth))) return { refused: `depth=${JSON.stringify(depth)} is not light or full` }
  const review = reviewOptions(a)
  if ('refused' in review) return review
  const bin = absolutePath(a['craftBin'])
  return { options: { repo: absolutePath(a['repo']) ?? '', base, depth: String(depth), craftBin: bin ? shellWord(bin) : null, craftRoot: absolutePath(a['craftRoot']) ?? '', ...review } }
}
