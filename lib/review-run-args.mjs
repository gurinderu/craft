// The review engine's options, read once from the Workflow sandbox's `args` (src/review.js): the scope, the
// launcher's memory, depth, extra and optional lenses, and the deadline override.
import { normalizeArgs } from './workflow-args.mjs'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { readLaunch } from './memory-recall.mjs'
import { pathSegments } from './path-segments.mjs'
import { parseDepth } from './review-depth.mjs'
import { parseExtraLenses } from './review-extra-lenses.mjs'
import { shq, loggerPrelude } from './run-logging.mjs'
import { OPTIONAL_LENSES, parseOptionalRequest } from './review-lens-tallies.mjs'

/**
 * The run's options; the launcher's memory and the lens-phase flag are read and set through the accessors.
 * @param {unknown} wfArgs  the sandbox's `args` @param {(message: string) => void} logLine  the sandbox's `log`
 * @param {string} craftVersion  the engine's release stamp
 */
export function readReviewArgs(wfArgs, logLine, craftVersion) {

// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs).

/** @type {Record<string, unknown>} */
const A = normalizeArgs(wfArgs, logLine)
/** A string argument as given, or '' when it is absent or falsy. @param {string} argName */
function argString(argName) {
  return A[argName] ? String(A[argName]) : ''
}
const baseArg = argString('base')
const intentArg = argString('intent')
const postComments = !!A['comment']
let pathArg = argString('path')   // optional crate-scope (audit per-crate fan-out)
// Absolute path to the repo under review, when it is NOT the directory the session runs in. Without
// it every agent runs `git diff` wherever the session happens to sit, so craft could only ever review
// its own checkout — reviewing a PR in another repo silently reviewed craft instead.
const repoArg = argString('repo')
// `path` is a git PATHSPEC resolved against the reviewed repo; `repo` selects the repo. An ABSOLUTE
// `path` is therefore ambiguous in the one way the sandbox cannot resolve: it is either a repo the
// caller meant to select, or a directory INSIDE the repo they meant to narrow to — and with no disk
// and no Node API here, nothing can tell those apart. Both wrong guesses are expensive and neither
// is loud. Guessing "repo" turns a narrowing request into a confident WHOLE-repo review wearing the
// narrow label; leaving it as a pathspec matches nothing, and the run comes back as an empty diff
// that reads like "no changes" — measured 2026-09-17 at 57 agents and 2.04M tokens, every one of
// the 14 lenses independently rediscovering that there was nothing to read.
// So: resolve it when the prefix DECIDES it, and refuse to guess otherwise (realm @nick/craft, #65).
// `~` counts as absolute here because the agent's shell expands it before git ever sees the pathspec.
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/])/
let ambiguousPath = ''
// A scope the caller asked for and did NOT get. It rides into `notRun` and therefore into the
// verdict line, not only into `log()`: dropping a narrowing widens the review to the WHOLE repo, so
// what was ordered and what was done diverge — and the person who reads the verdict is not the
// person who reads the log. An INCOMPLETE marker is the honest rendering of "we reviewed something
// else than you asked for", however green the findings are.
/** @type {string[]} */
let scopeNotRun = []
// The reader-facing twin of `scopeNotRun`: the same refusal spelled with this run's own paths, for
// the report. Kept apart because `notRun` is ranked by exact string (see the assignment below).
let scopeDetail = ''
// Containment decided on NORMALIZED SEGMENTS rather than on a raw string prefix. `repo=/r/` with
// `path=/r/./crates/../crates/core` is the same request as `repo=/r` with `path=crates/core`, and a
// prefix comparison reads it as "outside" — which silently WIDENS the review to the whole repository.
// Segments also settle the sibling case (`/r-evil` is not inside `/r`) that a bare `startsWith`
// accepts unless the separator is appended by hand.
// WHAT STAYS OUTSIDE THIS GUARD, because the sandbox has no disk and no Node API: a SYMLINK cannot be
// resolved (a path reaching the repo through a symlinked directory reads as outside), the comparison
// is case-SENSITIVE while macOS and Windows filesystems are not (`/R/crates` under `repo=/r` reads as
// outside), and a `..` that would climb above the first segment is kept as a literal segment, so such
// a path matches nothing. All three misread in the SAME direction — the scope is dropped, and a
// dropped scope is now reported in the verdict and in `notRun` — never in the direction of a
// narrowing that looks honoured and is not.
// The dropped scope, rendered into whichever report is returned — every early exit included, since
// the drop happened before all of them. Appended to the synthesized report too rather than asked of
// the synthesis model: what the review DID NOT cover is not something a prompt may forget.
const scopeSection = () => (scopeNotRun.length ? `\n\n## Scope\n⚠️ ${scopeDetail || scopeNotRun.join('\n⚠️ ')}\n` : '')
// The repo-relative spelling of `abs`, or null when `abs` is not inside `repo`.
/** @param {unknown} abs @param {unknown} repo */
function relativeToRepo(abs, repo) {
  const r = pathSegments(repo)
  const p = pathSegments(abs)
  if (!r.length || p.length < r.length) return null
  for (let i = 0; i < r.length; i++) if (p[i] !== r[i]) return null
  return p.slice(r.length).join('/')
}
// Settles an absolute `path` against `repo` once, before anything is dispatched.
function resolveScopePath() {
  if (ABSOLUTE_PATH.test(pathArg)) {
    const rel = repoArg ? relativeToRepo(pathArg, repoArg) : null
    if (rel != null) {
      // It names a directory inside the repo under review: that is a SCOPE, spelled absolutely. Keep
      // the narrowing the caller asked for — dropping it here would silently widen the review.
      logLine(`⚠️ path=${pathArg} is absolute but sits inside repo=${repoArg} — read as the repo-relative scope ${shq(rel)}.`)
      pathArg = rel
    } else if (repoArg) {
      const msg = `the requested scope path=${pathArg} was DROPPED: it is ABSOLUTE and does not resolve inside repo=${repoArg}, and an absolute pathspec matches nothing (the review would have seen an EMPTY diff). The review below therefore covers the WHOLE repository, not the requested scope — re-run with a repo-relative path to narrow it.`
      logLine(`⚠️ ${msg}`)
      // TWO STRINGS ON PURPOSE. `msg` is for a reader — it names this run's path and repo, and it
      // reaches the report's Scope section. `scopeNotRun` feeds the run record's `notRun`, which
      // lib/analyze-runs.mjs ranks BY EXACT STRING to surface repeated fragility: a path in there
      // makes every dispatch of the same shape its own count-1 row and sinks the real repeats. Same
      // argument that moved the uncovered-files note out of `notRun` entirely.
      scopeNotRun = ['the requested scope was DROPPED — an absolute `path` that does not resolve inside `repo`, so the review covered the whole repository instead']
      scopeDetail = msg
      pathArg = ''
    } else {
      // No `repo` to decide against. Refusing costs nothing and says exactly what to do; either guess
      // costs a full run and reports a scope nobody asked for.
      ambiguousPath = pathArg
    }
  }
}
resolveScopePath()
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. As an installed plugin
// CLAUDE_PLUGIN_ROOT is set for us; when the engine is launched by scriptPath from a checkout it is
// NOT, and the `:-.` fallback would resolve against the REVIEWED repo — the script would simply not
// be there and the whole record would be lost to a "Cannot find module". Pass craftRoot then.
const craftRootArg = argString('craftRoot')
// Every logger command runs as `cd <reviewed repo> && node <logger>`, so the `:-.` fallback would be
// resolved AFTER the cd — against the reviewed repo, where the script is not. That lost every
// checkpoint, the finalize record and the prior-round chain to "Cannot find module", silently.
// Resolve the path to an absolute one FIRST, in a variable, then change directory. The prelude
// itself is shared with every other record-filing engine (lib/run-logging.mjs).
// A FUNCTION, called at use time, so all three logger commands (the checkpoints, the finalize record
// and the prior-round read) are built from one prelude carrying the version — the one that once
// omitted it left the prior-round read refusing while the other two found their script.
const loggerPreludeNow = () => loggerPrelude(craftRootArg, craftVersion, repoArg)
const LOGGER_PATH = '"$CRAFT_LOGGER"'
const viaArg = argString('_via')   // set by a parent workflow (e.g. rust-audit)
const strict = !!A['strict']   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
// The crate-scoped mode (rust only, off by default; realm @nick/craft, #324): crate-confined lenses, a
// coordinator over a run-directory channel, the seam pass and the contract lens. Off, the engine dispatches as before.
const crateScope = A['crateScope'] === true || A['crateScope'] === 'true'
// The project's recorded rejections, passed by the launcher: they ADD to what this engine recalls itself
// once the diff's paths are known (recallMemory). Malformed → nothing of it applied, and every report says what was refused.
// Set by a parent workflow (rust-audit) that already recalled for this run and forwards the merged
// list: no recall here. `_memory` is that recall's outcome when it found none; `_memoryParts` how the
// list splits into its recall's records and its launcher's.
const recalledByLauncher = A['_recalled'] === true
const launch = readLaunch(A['priorDecisions'], recalledByLauncher, argString('_memory'), A['_memoryParts'], parsePriorDecisions)
let priorDecisionsIn = launch.prior
// Where the decisions came from; every report names it.
let memory = launch.memory
for (const r of priorDecisionsIn.refused) logLine(`⚠️ priorDecisions: ${r}`)
// The pin, RAW. Normalising it here as well as in `resolveProfilePin` is what made the helper's
// hardening unreachable: an `Array.isArray` guard here turned a scalar `languages: 'rust'` into
// `null` (pin silently dropped, review auto-detected instead), while a `.map(String)` turned
// `[null]` into the string `'null'` — an "unknown id" that hard-aborted the run. One normalizer:
// `resolveProfilePin` is the single place that decides what a pin means.
const requestedLangs = A['languages']
const freshArg = !!A['fresh']   // force a full first-pass review, ignore any prior round
// Every Nth re-review re-scans the FULL base...HEAD diff instead of only the fix delta, so a defect in
// code an intermediate round did not touch is re-discovered. Default 3; 1 = every re-review is a full
// re-scan (stateless, like adversarial-review); 0 = never (pure incremental — the pre-guard behavior).
const fullEvery = fullEveryArg()
/** @returns {number} */
function fullEveryArg() {
  return (A['fullEvery'] != null) ? Math.max(0, Number(A['fullEvery'])) : 3
}

// realm @nick/craft, node #295: `depth: 'light'` runs one round of the diff-scoped lenses and verifies
// Medium and above only; `extraLenses: [<agentType>, ...]` runs the consumer's own agents as lenses
// in the same run. The default depth, 'full', is the review as it was, plan for plan.
const depthRequest = parseDepth(A['depth'])
const reviewDepth = depthRequest.depth
const lightPass = reviewDepth === 'light'
function warnUnknownDepth() {
  if (depthRequest.unknown) logLine(`\u26a0\ufe0f depth=${JSON.stringify(depthRequest.unknown)} is not a depth (full, light) -- running the full review`)
}
warnUnknownDepth()
const extraLensRequest = parseExtraLenses(A['extraLenses'], lightPass)
/** The whole-diff lenses a light pass did not dispatch, across profiles. @type {Set<string>} */
const lightSkippedLenses = new Set()
/** The whole-diff lenses a light pass did dispatch, across profiles. @type {Set<string>} */
const lightKeptLenses = new Set()
/** Whether any profile reached its lens phase: a light report on an earlier exit says no lens ran. */
let lensPhaseReached = false
/** The extra lenses that answered, and those that did not, each with the class of its failure. */
const extraLensOutcome = { ran: /** @type {string[]} */ ([]), failed: /** @type {{ agent: string, why: string }[]} */ (extraLensRequest.refused.map(agentTypeName => ({ agent: agentTypeName, why: 'not an agent type name' }))), discovery: '', reached: false, exit: /** @type {{ reason: string, needed: boolean } | null} */ (null) }

const optionalRequest = parseOptionalRequest(A['optional'])
function warnUnknownOptional() {
  if (optionalRequest.unknown.length) {
    logLine(`⚠️ optional=${JSON.stringify(A['optional'])} names ${optionalRequest.unknown.join(', ')}, which is not an optional lens — the optional roster is ${OPTIONAL_LENSES.join(', ')}. Only the recognised names were admitted.`)
  }
}
warnUnknownOptional()
const optionalRequested = optionalRequest.lenses
// A caller-supplied ceiling, applied to every phase that does not name its own. It only ever
// REPLACES the per-phase table, never the explicit `deadlineMs` an individual dispatch passes —
// preflight's 5min is a property of preflight, not a default to be overridden from the outside.
const deadlineArg = deadlineArgMs()
function deadlineArgMs() {
  return Number(A['deadlineMs']) > 0 ? Number(A['deadlineMs']) : 0
}
return {
  A, baseArg, intentArg, postComments, pathArg, repoArg, ambiguousPath, scopeNotRun, scopeSection, craftRootArg, loggerPreludeNow, LOGGER_PATH,
  viaArg, strict, crateScope, recalledByLauncher, requestedLangs, freshArg, fullEvery, reviewDepth, lightPass, extraLensRequest, lightSkippedLenses, lightKeptLenses,
  extraLensOutcome, optionalRequested, deadlineArg,
  get priorDecisionsIn() { return priorDecisionsIn },
  set priorDecisionsIn(v) { priorDecisionsIn = v },
  get memory() { return memory },
  set memory(v) { memory = v },
  get lensPhaseReached() { return lensPhaseReached },
  set lensPhaseReached(v) { lensPhaseReached = v },
}
}
