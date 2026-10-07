export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial multi-phase diff review with bounded verifier fan-out — scout-scaled lenses, throttled batches with retries, strict-majority verification, verified coverage gaps. A run whose scout, lenses or coverage critic died reports its verdict as INCOMPLETE with a not-run list, never as a clean approval; unjudged individual checks are recorded as advisory instead. Subscription-friendly: steady request rate, no burst.',
  whenToUse: 'Deep adversarial, language-agnostic review of any diff — mixed / non-Rust-Nix codebases, or when money-path (payments/ledger) invariants matter, or on a rate-limited subscription (steady request rate). For a Rust or Nix diff prefer the `review` workflow (auto-detects language). Distinct from `review --strict`, which is the harsh maintainability-block mode of the generic engine. It reviews ONLY the checkout the session runs in: there is no `repo` argument, and passing one is refused with nothing run (use `review` with repo= instead).',
  phases: [
    { title: 'Prep', detail: 'scout the diff (size, lens subset) + warm up the codebase-memory index', model: 'haiku' },
    { title: 'Review', detail: 'scout-picked finder lenses, throttled batches with retries; two-tier dedup (mechanical + thresholded semantic clusterer)' },
    { title: 'Verify', detail: '1 combined verifier per finding, 3-lens panel for critical/high; throttled + retries + budget guard' },
    { title: 'Coverage', detail: 'completeness critic; its gaps are verified through the same pipeline' },
  ],
}

// ---- args ----
// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs, inlined below).
// >>> craft-inline lib/workflow-args.mjs applyOption parseOptions normalizeJsonArgs normalizeKeyValueArgs normalizeArgs
// One match of parseOptions' pattern, applied: a `--flag` or `key=value` stored into `out`, a refused
// name pushed onto `ignored`; 1 when it stored a pair, 0 when it refused one. Exported because a
// module-level helper is copied into the engines' inlined regions only when it is, and the fence's
// sibling check only knows about EXPORTS — a private helper reaches every engine as a ReferenceError
// on first use, with the gate green.
/**
 * @param {RegExpExecArray} m
 * @param {Record<string, unknown>} out
 * @param {string[]} ignored
 * @returns {number}
 */
function applyOption(m, out, ignored) {
  /** @param {string} k */
  const banned = k => k === '__proto__' || k === 'constructor' || k === 'prototype'
  if (m[7]) {
    if (banned(m[7])) { ignored.push(m[7]); return 0 }
    out[m[7]] = true
    return 1
  }
  const key = /** @type {string} */ (m[2])
  // `__proto__` is a live setter on a plain object: `__proto__={"craftRoot":"/evil"}` stores no own
  // key and yet makes `A.craftRoot` read `/evil`, which is interpolated into the shell instructions
  // the logger agent is handed. The args string is model-composed, so this is the same threat shape
  // as a model-supplied path, reached by a quieter door. A null-prototype object does not fix it on
  // its own — `Object.assign` back to a plain object re-triggers the setter — and these are never
  // legitimate option names, so they are refused by name and reported.
  if (banned(key)) { ignored.push(key); return 0 }
  const quoted = m[4] ?? m[5]
  if (quoted !== undefined) { out[key] = quoted; return 1 }
  try {
    out[key] = JSON.parse(/** @type {string} */ (m[3]))
  } catch {
    out[key] = /** @type {string} */ (m[3])
  }
  return 1
}

// Only `key=value` counts as an option, and that is a deliberate narrowing rather than a limitation.
// A bare word cannot become a flag: once any pair is present, the rest of an unquoted sentence would
// otherwise turn into options nobody wrote — `base=v1 intent=review the auth refactor strict` would
// invent `strict`, and an invented `strict` changes what the run does. A flag is written `strict=true`
// or `--strict`; a leading dash is an unambiguous statement of intent, a bare word is not.
/**
 * @param {string} text
 * @returns {{ options: Record<string, unknown>, pairs: number, ignored: string[] }}
 */
function parseOptions(text) {
  const pair = /(--?)?(\w[\w-]*)=("([^"]*)"|'([^']*)'|\S+)|(--)(\w[\w-]*)/g
  /** @type {Record<string, unknown>} */
  const out = {}
  let pairs = 0
  /** @type {string[]} */
  const ignored = []
  let m
  let cursor = 0
  while ((m = pair.exec(text)) !== null) {
    // Anything skipped over between matches is prose, not an option: collect it so the caller can say
    // what it ignored instead of silently swallowing half the input.
    const gap = text.slice(cursor, m.index).trim()
    if (gap) ignored.push(...gap.split(/\s+/))
    cursor = pair.lastIndex
    pairs += applyOption(m, out, ignored)
  }
  const tail = text.slice(cursor).trim()
  if (tail) ignored.push(...tail.split(/\s+/))
  return { options: out, pairs, ignored }
}

// normalizeArgs' branch for a string that starts with `{`.
/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeJsonArgs(text, warn) {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      warn('⚠️ args arrived as a JSON string, not an object — parsed it; pass a real object to avoid this')
      return parsed
    }
    warn('⚠️ args arrived as a non-object JSON value — ALL options ignored, running with defaults')
    return {}
  } catch (e) {
    warn(`⚠️ args arrived as a string that looks like JSON but is not (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 60)}) — ALL options ignored, running with defaults`)
    return {}
  }
}

// normalizeArgs' last branch: a non-empty string that is not JSON, read as `key=value` options.
/**
 * @param {string} text
 * @param {(msg: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function normalizeKeyValueArgs(text, warn) {
  const { options, pairs, ignored } = parseOptions(text)
  if (pairs) {
    // Counted, not inferred from the values: `mutants=true` is a pair whose value is boolean true,
    // and testing "is any value not true" threw away every string made only of boolean options —
    // `mutants=true` became {} with a warning saying the input was not understood, which is how a
    // requested mutation pass would silently not run.
    warn('⚠️ args arrived as a key=value string — parsed it; pass a real object to avoid this')
    if (ignored.length) {
      warn(`⚠️ ignored ${ignored.length} word(s) in args that are not options (${ignored.slice(0, 6).join(' ')}) — quote a value that contains spaces`)
    }
    return options
  }
  // Reaching here means a non-empty string that is neither JSON nor a single recognizable pair. The
  // loud path matters more than it looks: this is the branch a typo lands in, and defaults produce a
  // verdict that reads exactly like a requested one.
  warn(`⚠️ args arrived as an unrecognized string (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
  return {}
}

/**
 * Normalize whatever arrived into an options object.
 *
 * `warn` is called with one human sentence per degradation and must not throw — engines pass their
 * `log`. It is called on the recovered forms too, deliberately: a run that silently accepted a
 * shape it had to repair teaches the next caller nothing.
 *
 * @param {unknown} args
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, unknown>}
 */
function normalizeArgs(args, warn = () => {}) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return /** @type {Record<string, unknown>} */ (args)
  if (typeof args !== 'string' || !args.trim()) return {}
  const text = args.trim()
  // A JSON scalar or array is not an options object, and must not be mistaken for the key=value form
  // below: `[1,2,3]` and `"a sentence"` would otherwise become flags named after their own contents.
  if (text.startsWith('[') || text.startsWith('"')) {
    warn(`⚠️ args arrived as a JSON value that is not an object (${text.slice(0, 40)}) — ALL options ignored, running with defaults`)
    return {}
  }
  if (text.startsWith('{')) return normalizeJsonArgs(text, warn)
  return normalizeKeyValueArgs(text, warn)
}
// <<< craft-inline
const A = normalizeArgs(args, log)
/** @param {string} key @returns {string} the argument as a string, '' when absent or falsy */
const stringArg = key => A[key] ? String(A[key]) : ''

const diffBase = stringArg('diffBase')
const intentArg = stringArg('intent')
const viaArg = stringArg('_via')   // set by a parent workflow
// Where craft itself lives, so the logger can find lib/craft-log-run.mjs. It selects NO repository:
// this engine has no `repo` argument (see the refusal above) and always reviews the checkout the
// session runs in. As an installed plugin CLAUDE_PLUGIN_ROOT is
// set for us; launched by scriptPath from a checkout it is NOT, and the fallback would resolve
// against the reviewed repo — where the script is not. Pass craftRoot then.
const craftRootArg = stringArg('craftRoot')
/** @returns {number} */
const batchArg = () => A['batch'] ? Math.max(1, Number(A['batch'])) : 4
const BATCH = batchArg()
const RETRY_BATCH = 2                 // retry rounds run even quieter than the main pass
/** @returns {number} */
const maxRetriesArg = () => A['maxRetries'] != null ? Math.max(0, Number(A['maxRetries'])) : 2
const MAX_RETRY_ROUNDS = maxRetriesArg()
const BUDGET_FLOOR = 40_000           // stop spawning agents below this many remaining tokens

// ---- schemas ----
const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'description', 'fix', 'whereChecked'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          description: { type: 'string' },
          fix: { type: 'string' },
          whereChecked: { type: 'string', description: 'OFF-SITE EVIDENCE: the file:line you actually opened to establish a load-bearing premise living OUTSIDE the cited line — a dependency\'s behaviour, reachability from an entry point, the absence of a guard in a caller, what a sibling path does. Comma-separate several. Empty string ONLY when the finding rests on no off-site claim at all' },
        },
      },
    },
  },
}
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning', 'severity', 'premiseSupported'],
  properties: {
    refuted: { type: 'boolean' },
    premiseSupported: { type: 'boolean', description: 'true if the load-bearing premise is self-contained at the cited line or actually shown by the code at whereChecked; false if it is an off-site claim with no evidence that checks out. Unsupported is NOT the same as refuted — set refuted on its own merits' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'not-an-issue'] },
  },
}
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseRef', 'sizeBucket', 'lenses', 'changedFiles', 'notes'],
  properties: {
    baseRef: { type: 'string', description: 'git ref the diff was computed against; empty if none resolved' },
    sizeBucket: { type: 'string', enum: ['small', 'medium', 'large'] },
    lenses: { type: 'array', items: { type: 'string' }, description: 'subset of the lens catalog to run' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'EVERY path the diff touches, verbatim from `git diff --name-only` against the resolved base — repo-relative, no truncation, no globbing. An empty array means the diff genuinely resolved to no files; it is read as "nothing was reviewed", so never return [] as a shortcut' },
    notes: { type: 'string' },
  },
}
const WARMUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['indexed', 'notes'],
  properties: {
    indexed: { type: 'boolean', description: 'true if the codebase-memory index exists and covers the diff base' },
    notes: { type: 'string' },
  },
}

// Deterministic re-read of the diff's file list, used only to gate the inert-only green exit.
// `fileCount` comes from `wc -l`, `files` from the same command's output: the two disagreeing is
// how the cross-check's OWN truncation is caught, so both are required.
const CROSSCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'fileCount', 'files'],
  properties: {
    ok: { type: 'boolean', description: 'true only if git ran and files holds every path it printed, complete and verbatim' },
    fileCount: { type: 'integer', description: 'the number printed by `git diff --name-only <base> | wc -l`' },
    files: { type: 'array', items: { type: 'string' }, description: 'every path from `git diff --name-only <base>`, verbatim, untruncated' },
  },
}

// What each schema'd agent hands back when it returns at all. `agent()` resolves to `null` when the
// agent was skipped or died, so every read below goes through `Typedef | null`. The shapes are the
// schemas' — model output, so the guards that re-check a field at runtime stay where they are.
/**
 * @typedef {{ title: string, file: string, line: number, severity: string, description: string, fix: string, whereChecked: string }} RawFinding
 * @typedef {{ findings: RawFinding[] }} FindingsResult
 * @typedef {{ refuted: boolean, premiseSupported: boolean, reasoning: string, severity: string }} VerdictResult
 * @typedef {{ baseRef: string, sizeBucket: 'small' | 'medium' | 'large', lenses: string[], changedFiles: string[], notes: string }} ScoutResult
 * @typedef {{ indexed: boolean, notes: string }} WarmupResult
 * @typedef {{ ok: boolean, fileCount: number, files: string[] }} CrosscheckResult
 * @typedef {{ clusters: number[][] }} ClustersResult
 * @typedef {RawFinding & { lens: string, sources: string[] }} LensFinding  a finding tagged with the lens(es) that raised it
 */

/** @param {unknown} f @returns {f is string} a non-blank path from a model-returned file list */
const isPath = f => typeof f === 'string' && f.trim() !== ''

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const isEscalated = (/** @type {{ lens?: string, severity: string }} */ f) => f.lens !== 'complexity' && (f.severity === 'critical' || f.severity === 'high')

// The craft release that produced a run. Recorded on the run record and index line so an
// aggregate can be filtered to ONE engine version: without it, runs from every rubric the store
// has ever seen blend together. MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs`
// fails the build if it drifts. Kept OUTSIDE the craft-inline fence below, whose contents are
// byte-compared against lib/run-record.mjs.
const CRAFT_VERSION = '0.22.0' // x-release-please-version

// ---- run-record helpers (VERBATIM mirror of lib/run-record.mjs — the sandbox can't import; keep in sync) ----
// >>> craft-inline lib/run-record.mjs SEVERITIES countBySeverity summarizeFindings refuteRate repoRefusal
/** @type {Severity[]} */
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * @param {unknown} findings
 * @returns {Record<Severity, number>}
 */
function countBySeverity(findings) {
  const by = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[/** @type {Severity} */ (f.severity)] += 1
  }
  return by
}

/**
 * @param {unknown} findings
 * @returns {{ total: number, bySeverity: Record<Severity, number> }}
 */
function summarizeFindings(findings) {
  const bySeverity = countBySeverity(findings)
  return { total: SEVERITIES.reduce((n, s) => n + bySeverity[s], 0), bySeverity }
}

// Fraction of the judged candidates that were refuted: refuted / candidates, 2-dp, 0 when nothing was
// judged. review and adversarial-review record it. Not (candidates - confirmed) / candidates: review's
// `confirmed` excludes a "suspected" tier that is NOT refuted. rust-audit's unused-crates records
// null rather than 0 when nothing was judged, and computes that in lib/audit-verification.mjs.
/**
 * @param {number} refuted
 * @param {number} candidates
 * @returns {number}
 */
function refuteRate(refuted, candidates) {
  return candidates ? Math.round((refuted / candidates) * 100) / 100 : 0
}

// The refusal of a `repo` argument by an engine whose agents run git/cargo wherever the session sits:
// accepting it silently reads THIS checkout and reports a normal-looking verdict for the wrong code.
// The engine files `record` through its logRun — a repeated wrong dispatch has to reach the `notRun`
// fragility ranking — and returns `report`, before anything has run. One helper for every engine that
// refuses, so the record and the advice cannot drift between them.
/**
 * @param {{ engine: string, repo: string, craftVersion: string, outputTokens: number, via?: string }} o
 *   `via`: the parent workflow that dispatched this run, '' when it was not nested
 */
function repoRefusal({ engine, repo, craftVersion, outputTokens, via = '' }) {
  return {
    record: {
      schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: engine,
      nested: !!via, via: via || null,
      verdict: 'INCOMPLETE (repo not supported)', findings: summarizeFindings([]), dimensions: [], verification: null,
      // The CLASS, not the caller's path: `notRun` is ranked by exact string, so a path here would
      // make every repetition of this same misuse its own count-1 row.
      notRun: ['`repo` argument refused — this engine reviews only the session\'s own checkout'],
      outputTokens,
    },
    report: [
      `## Verdict`,
      `⚠️ INCOMPLETE — \`repo=${repo}\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
      ``,
      `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
    ].join('\n'),
  }
}
// <<< craft-inline
// ---- the one write path (shared with every other record-filing engine) ----
// The sandbox cannot import, so lib/run-logging.mjs reaches this script the same way run-record.mjs
// does: a fenced region regenerated and byte-compared by `node lib/check-workflows.mjs`.
// >>> craft-inline lib/run-logging.mjs LOGRUN_SCHEMA shq loggerPrelude payloadVersion engineRevisionFlag runDirFlags logRunPrompt logRunDispatch logRunOutcome quietly makeRunLogger telemetryLossNoter
// Asked of the logger agent so a failed write is ASSERTED, not inferred from a missing field.
const LOGRUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the script ran and printed no craft-log-run FAILED line' },
    // The description is what the model steers this field by, so it has to name the WARNING case too:
    // reading "empty otherwise" it returns '' on a landed-but-degraded run, and the engine's
    // telemetry-loss branch — the whole reason the field is populated on success — never fires.
    error: { type: 'string', description: 'when ok is false, the failing line verbatim; when ok is true AND the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}

/** @param {unknown} s */
function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

// Every logger command runs as `cd <reviewed repo> && node <logger>`, so a `:-.` fallback resolved
// AFTER the cd points at the REVIEWED repo, where the script is not — that lost every record to a
// silent "Cannot find module". Resolve the logger to an absolute path FIRST, into a variable, and
// only then change directory. `craftRoot` is passed when the engine is launched by scriptPath from
// a checkout (CLAUDE_PLUGIN_ROOT is unset then); as an installed plugin the env var is set for us.
// The `:-.` fallback is GONE, and that is a security fix, not tidying. It resolved before the `cd`,
// so `.` was the logger agent's starting directory — which, in the deployment this plugin is built
// for, is the repository under REVIEW. A reviewed repository shipping its own `lib/craft-log-run.mjs`
// would then be executed with the user's privileges by a workflow whose whole premise is that the
// reviewed repo is untrusted. Extraction would have carried that from one engine to four.
// It is emitted FIRST, before any staging: `${VAR:?}` is a hard abort in a non-interactive shell, so
// after the `cat` it killed the block before `rm -f` and left the whole record in TMPDIR — on exactly
// the path this loud failure was added for.
// A record that cannot be written is already a reported, non-fatal outcome (logRunOutcome →
// noteTelemetryLoss → the report), so refusing to guess a path costs a marker, not a run.
/**
 * @param {string | undefined} craftRoot
 * @param {string} [version]
 * @param {string} [repo]
 */
function loggerPrelude(craftRoot, version = '', repo = '') {
  // ONE pipeline for every way the logger can be located, and that uniformity is the fix rather than
  // a tidy-up. Each source used to get its own treatment: an explicit `craftRoot` returned EARLY,
  // before the absoluteness check and before the refusal, so a review launched with `craftRoot=.`
  // emitted `CRAFT_LOGGER='.'/lib/craft-log-run.mjs` and then `cd <reviewed repo> && node
  // "$CRAFT_LOGGER"` — the removed `:-.` hole restored verbatim, bypassing the version pin and the
  // loud refusal too. `craftRoot` arrives in the model-composed args string, so it is exactly as
  // untrusted as the `--dir` this project already refuses.
  //
  // Three properties now hold for every candidate without exception:
  //   ABSOLUTE — `[ -f ]` is evaluated in the logger agent's cwd while `node` runs AFTER the cd into
  //     the reviewed repository, so any relative path resolves THERE. Refused outright rather than
  //     normalized: guessing what the caller meant is how this class keeps coming back.
  //   PRESENT — a path that names no file is not a logger.
  //   ORDERED — explicit root, then the environment, then this engine's own installed copy. The
  //     search is a fallback, never an override: written the other way round it overwrote a good
  //     path with whatever the cache held, so a launch from a checkout logged through another build.
  //
  // The search is version-pinned to what this engine is stamped with (a record filed by another
  // build's script misdescribes which engine ran, and gets counted), looks only under the user's own
  // plugin cache, honours $CLAUDE_CONFIG_DIR because a session configured that way keeps its plugins
  // elsewhere, and never looks at the reviewed repository at all. That cache layout belongs to the
  // harness, not to craft (realm @nick/craft, node #48 — observed, not documented), so a miss is
  // ordinary: not found means the refusal below, never a guess.
  // ONE predicate, applied to every candidate, and applied BEFORE it is accepted rather than to the
  // winner afterwards. Written as a terminal check on the winner, an explicit craftRoot naming the
  // repo killed the whole command instead of being rejected in favour of the next candidate — which
  // is craft reviewing its own checkout, the mode this repo mandates for itself.
  //
  // A candidate qualifies only if it is ABSOLUTE (`[ -f ]` runs in the agent's cwd while `node` runs
  // after the cd, so a relative path resolves in the reviewed repository), PRESENT, and OUTSIDE the
  // directory the command is about to cd into. The last is checked on the FULLY resolved path:
  // symlinks are followed to their target — a link whose FILE points into the repo passed for one
  // commit because only the directory went through `pwd -P` — and both sides are normalized, so a
  // `..` climb and a symlinked parent collapse to the same comparison. The `case` patterns are
  // quoted and slash-anchored, so a sibling that merely shares a prefix (`/x/repo-evil` beside
  // `/x/repo`) is NOT inside — the collision this project already met once in `insideStore`.
  // EVERY exit from this predicate that is not a clean, fully resolved, outside-the-repo path is a
  // REFUSAL. Three of them used to fall through to acceptance, and one was reachable: exhausting the
  // hop bound left the loop with the path still a symlink, the comparison then tested an unresolved
  // string, nothing matched, and the candidate was accepted — a 21-link chain ending inside the
  // reviewed repository executed its script. A bound that fails open is not a bound; it is a longer
  // attack.
  //
  // Two of the three refusals are belt-and-braces and are labelled as such rather than dressed up as
  // covered: with `CRAFT_REPO` empty the `case` pattern degenerates to `/*`, which matches every
  // absolute path and refuses anyway; and `pwd -P` can only fail on a directory with no `x` bit,
  // where `[ -f ]` has already failed one line earlier. Removing either guard changes no observable
  // behaviour, so no test distinguishes them — stated here instead of implied by a test that would
  // pass either way.
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {   # a line that is exactly '}' at column 0 would end the extracted region early
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -f "$1" ] || return 1
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  return 0
 }
CRAFT_LOGGER=""
`
  // The RESOLVED path is what gets used, not the candidate string that was validated. Between the
  // check and `node "$CRAFT_LOGGER"` sit the mktemp, the whole heredoc of a record that can be
  // hundreds of kilobytes, and the cd — a window in which a symlink component of the unresolved
  // candidate can be re-pointed into the reviewed repository. Handing over the path that was
  // actually checked closes that window and costs nothing.
  /** @param {string} expr */
  const tryCandidate = expr => `if [ -z "\${CRAFT_LOGGER:-}" ]; then
  CRAFT_TRY=${expr}
  craft_usable "$CRAFT_TRY" && CRAFT_LOGGER="$CRAFT_REAL"
fi
`
  const explicit = craftRoot ? tryCandidate(`${shq(craftRoot)}"/lib/craft-log-run.mjs"`) : ''
  const fromEnv = tryCandidate('"${CLAUDE_PLUGIN_ROOT:-}/lib/craft-log-run.mjs"')
  const installed = version
    ? tryCandidate(`"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/lib/craft-log-run.mjs"`)
    : ''
  return `${preamble}${explicit}${fromEnv}${installed}[ -n "\${CRAFT_LOGGER:-}" ] || { echo "craft-log-run FAILED: no usable logger — no absolute craftRoot outside the reviewed repo, no CLAUDE_PLUGIN_ROOT, and no installed copy of "${version ? shq(version) : "'this version'"}" under the plugin cache; refusing to resolve against the reviewed repository"; exit 1; }
`
}

// The craft version a record or checkpoint payload claims, as text ('' when it claims none).
/** @param {unknown} payload @returns {string} */
function payloadVersion(payload) {
  return String((payload && typeof payload === 'object' ? /** @type {{ craftVersion?: unknown }} */ (payload).craftVersion : undefined) ?? '')
}

// The engine's revision a SECOND time, on the command line the engine composes itself (realm
// @nick/craft, node #114). It decides which fingerprint basis a later round reads this run under, and
// the payload it also rides in is re-emitted by the logger agent — so craft-log-run files it only when
// the two copies agree; one altered copy files an unknown basis, never a wrong one. Emitted only for a
// payload that stamps an integer revision: an engine that stamps no basis sends no flag.
/** @param {unknown} payload @returns {string} */
function engineRevisionFlag(payload) {
  const rev = payload && typeof payload === 'object' ? /** @type {{ workflowEngineRevision?: unknown }} */ (payload).workflowEngineRevision : undefined
  return Number.isInteger(rev) ? `--engine-revision ${rev} ` : ''
}

// The logger flags both prompts share: `--dir`, `--rejoin` and the shell-expanded session id, each
// independent of the others (see logRunPrompt below), with the trailing space the command line needs.
/** @param {string} dir @param {boolean} rejoin @returns {string} */
function runDirFlags(dir, rejoin) {
  return `${dir ? `--dir ${shq(dir)} ` : ''}${rejoin ? '--rejoin ' : ''}\${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} `
}

// The prompt that carries ONE record to disk. `command` is `write` (one-shot: detail file, verified
// readback, index line) or `finalize` (the same, plus folding in this run's phase checkpoints —
// review.js is the only engine that checkpoints). Nothing here asks the model to compute anything.
// THE STAGING FILE IS PER-RUN, AND THAT IS LOAD-BEARING. It used to be the fixed `/tmp/craft-rec.json`
// in one engine; extracting the prompt propagated that path to all four, which is three new ways to
// be wrong at once. (a) `cat >` follows a symlink, so any other local uid can pre-create that name
// pointing at a file this user owns and have the next run truncate it — an arbitrary-overwrite
// primitive on a shared or CI box, and `/tmp`'s sticky bit does not stop CREATING an entry. (b) The
// record holds every finding title, path and quoted snippet from the reviewed repo, and a default
// umask leaves it world-readable, never removed. (c) A fixed name carries no run id, while craft's
// own fan-out puts several runs in flight — rust-audit dispatches one nested review per changed crate
// through `parallel` — so between one agent's `cat >` and its own redirect another can overwrite the
// file: run A files run B's record under A's identity, the script succeeds, the readback verifies,
// `{ok:true}` comes back and NOTHING reports a loss. `mktemp` answers all three: unique name, 0600,
// created without following anything. The exit code is carried past the cleanup so a failed write
// still reports as one.
// `repo` steers the logger's `cd`, and THAT IS ALL IT STEERS. It is meaningful only for an engine
// whose review agents are pointed at the same checkout (review.js does that with REPO_DIRECTIVE);
// passed by an engine whose agents run in the session's cwd, it would file a record attributed to a
// repository the run never looked at — a lie in the one field the store is keyed by.
/** @param {{ record?: unknown, craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} [opts] */
function logRunPrompt({ record, craftRoot = '', repo = '', command = 'write', dir = '', rejoin = false } = {}) {
  // The version comes off the RECORD rather than from a parameter of its own: it is already there,
  // and taking it from anywhere else lets the copy the logger is looked up by drift from the version
  // the record claims to be — which would file a record describing a run some other build made.
  const version = payloadVersion(record)
  // `${CLAUDE_CODE_SESSION_ID:+--session "..."}` is shell-expanded INSIDE the script the logger agent
  // runs, never composed by the model — the whole point (see the header note on the payload-copy
  // incident this file already documents). `:+` is deliberate over `:-`: it fires only when the var
  // is BOTH set and non-empty, so an unset session id degrades to no flag at all rather than the
  // logger receiving the literal string "" and treating it as a real (empty) session id.
  // `--dir` and `--rejoin` are INDEPENDENT, and the `!dir &&` that used to gate the second one was a
  // silent contract break. review.js finalized with `{ dir: runDir, rejoin: checkpointFailed }`, so
  // any run that had a runDir at all sent the directory and swallowed the rejoin — the CLI then read
  // `rejoin: false` for a directory that may well have been ADOPTED by an earlier `--rejoin`
  // checkpoint. What depends on the flag arriving is the OWNERSHIP proof: it is the engine's own
  // statement that its `runDir` may have been adopted, and nothing downstream can reconstruct that
  // from the directory alone. It is NOT a fallback for a refused `--dir` — `finalizeRun` refuses the
  // rejoin search outright in that case (see its `target` comment), because the single candidate a
  // garbled sibling finds is its neighbour's LIVE directory.
  const flags = runDirFlags(dir, rejoin)
  return `You are the craft observability logger. Persist ONE run record. This is mechanical IO — do not analyze, summarise, reformat or "clean up" any part of it.

Run exactly this:

\`\`\`
${loggerPrelude(craftRoot, version, repo)}CRAFT_REC="$(mktemp "\${TMPDIR:-/tmp}/craft-rec.XXXXXX")"
cat > "$CRAFT_REC" <<'CRAFT_RECORD_EOF'
…RECORD below, byte for byte…
CRAFT_RECORD_EOF
cd ${shq(repo || '.')} && node "$CRAFT_LOGGER" ${command} ${engineRevisionFlag(record)}${flags}--project "$PWD" < "$CRAFT_REC"; CRAFT_RC=$?; rm -f "$CRAFT_REC"; exit $CRAFT_RC
\`\`\`

The script computes every field (ts, project, commit, dirty, engineRevision, craftCommit, and — reading the working copy with git — branch and head, whose values in the record below are only a fallback for what git cannot resolve), names the file, appends the index line and verifies the readback. You compute NONE of that. In particular: do NOT \`mkdir\` the store, do NOT run \`date\`, \`pwd\` or \`git\` yourself, and do NOT append to index.jsonl by hand.

COPY THE RECORD VERBATIM into the quoted heredoc — it can be hundreds of KB (findings, ledger, dimensions), and re-emitting it from memory silently drops the big arrays. That is exactly how a completed review once persisted \`findings: 111\` with \`dimensions: []\` and no \`verification\`, destroying the per-lens telemetry the whole store exists for.

If the script prints a line starting \`craft-log-run FAILED\`, or the command itself fails (for example the logger path does not exist), return {"ok": false, "error": "<that line, or the shell error, verbatim>"} and stop — do NOT fall back to writing the file by hand. If it succeeded, return {"ok": true} — and if it ALSO printed a line starting \`craft-log-run WARNING\`, return {"ok": true, "error": "<that line verbatim>"}: the record landed, but something about the run directory did not, and the engine has to be able to say so. Best-effort either way: never error the run over this.

RECORD:
${JSON.stringify(record, null, 2)}`
}

// Copying a large record verbatim is not a low-effort task: haiku is fine for a gate-failed stub,
// but a full review record carries every finding plus the ledger, and the cheap model is where the
// silent truncation came from. Size the model to the payload.
// The options are typed as the sandbox's `agent()` takes them — `effort` a literal, not a string — so an
// engine passes them on as they are.
/**
 * @param {unknown} record
 * @param {{ phase?: string }} [opts]
 * @returns {{ label: string, phase: string, schema: typeof LOGRUN_SCHEMA, model: 'sonnet' | 'haiku', effort: 'low' }}
 */
function logRunDispatch(record, { phase = '' } = {}) {
  const payloadKB = JSON.stringify(record).length / 1024
  const big = payloadKB > 24
  return {
    label: `log-run${big ? ` (${Math.round(payloadKB)}KB)` : ''}`,
    phase,
    schema: LOGRUN_SCHEMA,
    model: big ? 'sonnet' : 'haiku',
    effort: 'low',
  }
}

/**
 * @param {unknown} res harness result of the logger agent (model output), or a quiet call's `{ __threw }`
 * @returns {{ ok: boolean, reason: string }}
 */
function logRunOutcome(res) {
  const r = res && typeof res === 'object' ? /** @type {{ ok?: unknown, error?: unknown, __threw?: unknown }} */ (res) : null
  // A WARNING is not a loss: the record IS on disk, and only the run DIRECTORY was refused or left
  // behind. Reporting it as a lost record would send a reader hunting for a file that exists, and a
  // marker that fires on a landed write is one people stop reading. But it must not vanish either —
  // the caller gets `ok: true` with a reason to surface.
  if (r && r.ok === true) return { ok: true, reason: String((r.error || '')).trim() }
  return { ok: false, reason: String((r && (r.__threw || r.error)) || 'the logger agent returned no result') }
}

// For the agent calls whose FAILURE is not the caller's problem: the run record, the phase
// checkpoints, the prior-round read. They are bookkeeping — every other agent in these engines
// produces review content, so a throw there should stop the run. These must not: the record is
// written AFTER the report already exists in memory, so losing it to a bookkeeping write would
// throw away the whole run's product.
/**
 * @template P, O, R
 * @param {(prompt: P, opts: O) => Promise<R>} call a harness agent callback
 * @returns {(prompt: P, opts: O) => Promise<R | { __threw: string }>}
 */
function quietly(call) {
  return async (prompt, opts) => {
    try {
      return await call(prompt, opts)
    } catch (e) {
      return { __threw: String((e && /** @type {{ message?: unknown }} */ (e).message) || e) }
    }
  }
}

// The run-record writer each engine binds as its `logRun` — one body for all four. What differs
// between engines is BOUND, not copied: the agent call (review's retries underneath `quietly`, the
// others' plain `agent`), the phase the write is dispatched under, where the logger writes (`target`,
// read at each call: review finalizes into a `runDir` that only exists once a checkpoint has run),
// what is stamped onto every record (`prepare`: review's fingerprint basis), and how a loss is noted
// (review's one noteTelemetryLoss for every bookkeeping write; telemetryLossNoter for the others).
// A lost record NEVER fails the run: it is noted, and the engine renders the note where a human reads.
// The returned function must still be bound to the NAME `logRun` in the engine — see the header.
/**
 * @template O
 * @param {object} o
 * @param {(prompt: string, opts: ReturnType<typeof logRunDispatch>) => Promise<O>} o.call  a `quietly`-wrapped agent callback
 * @param {string} o.phase
 * @param {() => { craftRoot?: string, repo?: string, command?: string, dir?: string, rejoin?: boolean }} o.target
 * @param {(what: string, why: string, landed: boolean) => void} o.noteLoss
 * @param {(record: Record<string, unknown>) => Record<string, unknown>} [o.prepare]
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
function makeRunLogger({ call, phase, target, noteLoss, prepare = record => record }) {
  return async recordIn => {
    const record = prepare(recordIn)
    const landed = logRunOutcome(await call(logRunPrompt({ ...target(), record }), logRunDispatch(record, { phase })))
    if (!landed.ok) noteLoss('the run record', landed.reason, false)
    // The record landed and the script still had something to say — a run directory refused or left
    // behind. Not a lost record, so it must not read as one, but not silence either.
    else if (landed.reason) noteLoss('the run directory (the record itself landed)', landed.reason, true)
  }
}

// The loss note of the engines that keep no other bookkeeping writes: every loss is kept for the
// report, and logged — a landed record under its own prefix, never as a lost one.
/**
 * @param {string[]} lost
 * @param {(line: string) => void} say
 * @returns {(what: string, why: string, landed: boolean) => void}
 */
function telemetryLossNoter(lost, say) {
  return (what, why, landed) => {
    lost.push(`${what} — ${why}`)
    say(landed ? `⚠️ telemetry: ${why}` : `⚠️ telemetry lost: ${what} — ${why}`)
  }
}
// <<< craft-inline

// A lost record NEVER fails the run: killing a review over a bookkeeping write would teach everyone
// to ignore the very marker this exists to raise. It is reported instead — in the notRun notes a
// human actually reads, because an empty store is otherwise indistinguishable from "never run".
/** @type {string[]} */
const telemetryLost = []
// "lost" is asserted per line, not stamped on every line: the record landing while its run DIRECTORY
// was refused is a different fact, and calling it a lost record is the same conflation the other
// three engines dropped — the one that teaches a reader to skip the marker. A line that says the
// record itself landed keeps its own wording.
const telemetryNotes = () => telemetryLost.map(l => (
  /^the run directory \(the record itself landed\)/.test(l)
    ? `⚠️ telemetry: ${l} — the record for this run is in the store; what the directory held may not be.`
    : `⚠️ telemetry lost: ${l} — this run may be missing or incomplete in the run store. Read this verdict, not the store, for what it did.`))

// The shared run-record writer (lib/run-logging.mjs), bound to this engine's phase and loss note.
const logRun = makeRunLogger({
  call: quietly(agent), phase: 'Coverage', target: () => ({ craftRoot: craftRootArg }),
  noteLoss: telemetryLossNoter(telemetryLost, log),
})
// adversarial-review uses lowercase severities internally; the store schema is capitalized.
/** @template {{ severity: string }} F @param {F} f */
const capSeverity = f => ({ ...f, severity: f.severity ? f.severity.charAt(0).toUpperCase() + f.severity.slice(1) : f.severity })

// The fields every run record of this engine opens with, in the order the store has always seen them.
const recordHead = () => ({
  schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'adversarial-review',
  nested: !!viaArg, via: viaArg || null,
})

// ---- lens catalog ----
/** @type {Record<string, string>} */
const LENS_BRIEF = {
  correctness: 'logic and spec conformance: does the change do what it is supposed to? Wrong behavior behind correct-looking code, off-by-one, inverted conditions, missed requirements, broken invariants.',
  security: 'security: injection, authz/authn gaps, tenant isolation breaks, secrets in code, unsafe deserialization, path traversal, SSRF, untrusted input reaching sinks.',
  money: 'money-path invariants: float arithmetic on amounts, lost cents in splits/rounding, missing idempotency on payment operations, double-charge/double-credit windows, currency mixups, ledger imbalance.',
  concurrency: 'concurrency: races on shared state, check-then-act windows, missing transactions/locks, lock ordering, blocking calls in async contexts, unbounded queues.',
  errors: 'error handling: swallowed errors, panic/crash on recoverable failures, missing rollback/cleanup on the error path, error messages leaking internals.',
  performance: 'performance: N+1 queries, work inside hot loops, unbounded memory growth, missing pagination/limits, accidental O(n^2).',
  complexity: 'complexity metrics from the codebase-memory graph (metrics-or-nothing; skipped when the repo is not indexed).',
}
const ALL_LENSES = Object.keys(LENS_BRIEF)

/** @param {string} lens */
function finderPrompt(lens) {
  const base = diffBase ? `\`${diffBase}\`` : 'resolve it yourself: merge-base with origin/main, then main, then HEAD~1; target uncommitted changes if the tree is dirty'
  if (lens === 'complexity') {
    return `You are the complexity review lens, grounded in the codebase-memory knowledge graph.
Use ToolSearch to load the codebase-memory MCP tools (list_projects, index_status, detect_changes, search_graph, query_graph).

Step 0 — availability gate: call list_projects / index_status for this repository. If the project is NOT indexed, or the index predates the diff base, return {"findings": []} immediately. Never estimate complexity by eye; this lens is metrics-or-nothing.
Step 1: detect_changes (diff base: ${base}) to get the functions touched by the diff and their impact radius.
Step 2: for each touched function, read its complexity properties from the graph: cognitive, complexity (cyclomatic), loop_depth, transitive_loop_depth, linear_scan_in_loop, alloc_in_loop, recursion_in_loop, unguarded_recursion, param_count. One query_graph call can fetch them all.
Step 3: report ONLY findings grounded in those numbers, quoting the metric values in the description. Calibrate severity by whether THIS diff introduced or worsened the metric, not by pre-existing debt:
- diff introduces/deepens transitive_loop_depth >= 3 on a caller-reachable path -> high
- diff adds linear_scan_in_loop (hidden O(n^2)) or alloc_in_loop on a hot path -> medium..high
- diff adds unguarded_recursion or recursion_in_loop -> high
- diff sharply raises cognitive complexity of a function -> medium
- pre-existing debt merely touched by the diff -> low, mention briefly
Each finding: exact file, line, metric values, and a concrete fix (extract, hoist the scan, use a map, cap recursion).

Return {findings: []-shaped JSON}.`
  }
  return `You are the **${lens}** review lens for a diff. Review ONLY this slice; ignore everything else (other lenses cover it).

SLICE: ${LENS_BRIEF[lens]}
Diff base: ${base}.
${intentArg ? `INTENT (what the change should do): ${intentArg}` : ''}
CONTEXT EXPANSION (required): for each finding, read the surrounding code and trace callers of the changed symbols before judging — do not read the diff in isolation.
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Pin every such premise to a \`file:line\` you ACTUALLY OPENED, dependency sources included, and put them in \`whereChecked\`. An off-site premise you did not open is not admissible: open it, or drop the claim and report only what the cited line shows. Use "" only when the finding needs no off-site premise.
CONFIDENCE: report everything you suspect, located to file:line. Do NOT self-censor borderline findings — adversarial verification happens downstream.

Return {findings: []-shaped JSON}.`
}

// ---- throttled runner (VERBATIM mirror of lib/throttled-runner.mjs — the sandbox can't import) ----
// The runner reports its own leftovers into `notRun`; callers that report them their own way (the
// finder lenses, which mark one BLOCKING entry per dead dimension) pass `reportUnjudged: false`.
// >>> craft-inline lib/throttled-runner.mjs unjudgedNotRun makeThrottledRunner
// One not-run entry per throttled pass that ended with unfinished jobs — and NONE when the pass
// finished, which is the whole discipline: a marker that fires on healthy runs is one people stop
// reading.
// It used to claim the unjudged findings "stay Suspected". That was FALSE for an escalated finding:
// its panel members are separate jobs, so one dead lens leaves a 1-1 split that `judge` reads as a
// refutation, and refuted findings are dropped from the report entirely. The premise is now enforced
// at the judge instead of asserted here (a panel that lost a member decides nothing), and this note
// no longer promises an outcome it does not produce.
// Advisory by default, blocking when the pass judged NOTHING — the two are genuinely different: a
// gap in a panel is a weakened judgement, an empty pass is no judgement at all.
/**
 * @param {string} tag
 * @param {unknown[] | number | null | undefined} unfinished
 * @param {{ total?: number }} [opts]
 * @returns {{ label: string, note: string, incomplete: boolean }[]}
 */
function unjudgedNotRun(tag, unfinished, { total = 0 } = {}) {
  const count = Array.isArray(unfinished) ? unfinished.length : Number(unfinished) || 0
  if (count <= 0) return []
  const key = String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'checks'
  // A pass that judged NOTHING is not an advisory footnote: no finding in it was verified at all,
  // and a verdict built on that is a verdict about nothing. It downgrades the run like a dead lens.
  const wholePass = total > 0 && count >= total
  return [{
    label: `${key}-checks-unjudged`,
    note: wholePass
      ? `the entire ${tag} pass produced no verdict (${count} check(s)) — nothing it was judging was verified`
      : `${count} ${tag} check(s) got no verdict — the findings they were judging were decided on a partial panel, or not decided at all`,
    incomplete: wholePass,
  }]
}

// Runs `jobs` in batches of `batch`, retrying whatever produced no result in quieter rounds of
// `retryBatch`, and stops spawning below the budget floor. Returns the jobs that never produced a
// result. Each job: {prompt, label, schema, effort, onResult, onMissing?}.
/**
 * @typedef {object} ThrottledJob
 * @property {string} prompt
 * @property {string} label
 * @property {object} [schema]
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [effort]
 * @property {(v: unknown) => void} onResult  `v` is the agent's answer (model output), never null
 * @property {() => void} [onMissing]
 */
/**
 * @typedef {object} ThrottledDeps
 * @property {(prompt: string, opts: { label: string, phase: string, schema?: object | undefined, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined }) => Promise<unknown>} agent
 * @property {(fns: Array<() => Promise<unknown>>) => Promise<unknown[]>} parallel
 * @property {(msg: string) => void} log
 * @property {(label: string, note: string, incomplete: boolean) => void} markNotRun
 * @property {number} batch
 * @property {number} retryBatch
 * @property {number} maxRetryRounds
 * @property {{ total: number | null, remaining: () => number }} budget  `total` is null when no token target was set
 * @property {number} budgetFloor
 */
/**
 * @param {ThrottledDeps} deps
 * @returns {(jobs: ThrottledJob[], tag: string, phaseTitle: string, opts?: { reportUnjudged?: boolean }) => Promise<ThrottledJob[]>}
 */
function makeThrottledRunner(deps) {
  const { agent, parallel, log, markNotRun, batch: BATCH, retryBatch, maxRetryRounds, budget, budgetFloor } = deps
  // One round over `pending` in batches of `size`: the jobs that produced no result, and — when the
  // budget guard stopped the round — every job left unfinished (null when it ran to the end).
  /**
   * @param {ThrottledJob[]} pending
   * @param {number} size
   * @param {number} round
   * @param {string} tag
   * @param {string} phaseTitle
   * @param {{ done: number, jobs: ThrottledJob[] }} progress  `done` counts across rounds
   * @returns {Promise<{ failed: ThrottledJob[], unfinished: ThrottledJob[] | null }>}
   */
  const runRound = async (pending, size, round, tag, phaseTitle, progress) => {
    /** @type {ThrottledJob[]} */
    const failed = []
    for (let i = 0; i < pending.length; i += size) {
      if (budget.total && budget.remaining() < budgetFloor) {
        const skipped = pending.length - i + failed.length
        log(`Budget guard: ~${Math.round(budget.remaining() / 1000)}k tokens left -> stopping ${tag}, ${skipped} calls skipped`)
        return { failed, unfinished: pending.slice(i).concat(failed) }
      }
      const slice = pending.slice(i, i + size)
      const res = await parallel(slice.map(j => () =>
        agent(j.prompt, { label: (round ? `retry${round}:` : '') + j.label, phase: phaseTitle, schema: j.schema, effort: j.effort })))
      res.forEach((v, k) => {
        if (v) { /** @type {ThrottledJob} */ (slice[k]).onResult(v); progress.done++ } else failed.push(/** @type {ThrottledJob} */ (slice[k]))
      })
      log(`${tag}: ${progress.done}/${progress.jobs.length} calls done`)
    }
    return { failed, unfinished: null }
  }
  /**
   * @param {ThrottledJob[]} unfinished
   * @param {string} tag
   * @param {number} total
   * @param {boolean} reportUnjudged
   */
  const settle = (unfinished, tag, total, reportUnjudged) => {
    // A job that never produced a verdict must leave a TRACE where the verdict would have gone, not
    // only a line in the run record. Its absence is what the judge has to see: a panel silently one
    // vote short reads as a whole panel, and a 1-1 split then counts as a refutation.
    for (const j of unfinished) if (typeof j.onMissing === 'function') j.onMissing()
    // `total` lets the entry tell a gap apart from a pass that judged nothing — including the pass
    // stopped by the budget guard before it spawned its first agent, which returned an empty
    // leftover list and therefore reported as clean.
    if (reportUnjudged) for (const e of unjudgedNotRun(tag, unfinished, { total })) markNotRun(e.label, e.note, e.incomplete)
  }
  return async function runThrottled(jobs, tag, phaseTitle, { reportUnjudged = true } = {}) {
    let pending = jobs
    const progress = { done: 0, jobs }
    /** @type {ThrottledJob[] | null} */
    let unfinished = null
    for (let round = 0; round <= maxRetryRounds && pending.length && !unfinished; round++) {
      const size = round === 0 ? BATCH : retryBatch
      if (round > 0) log(`${tag} retry round ${round}: ${pending.length} failed calls, batches of ${size}`)
      const ran = await runRound(pending, size, round, tag, phaseTitle, progress)
      unfinished = ran.unfinished
      if (!unfinished) pending = ran.failed
    }
    if (!unfinished) unfinished = pending
    settle(unfinished, tag, jobs.length, reportUnjudged)
    return unfinished
  }
}
// <<< craft-inline

// ---- coverage honesty (VERBATIM mirror of lib/review-coverage.mjs — the sandbox can't import) ----
// Only the LANGUAGE-AGNOSTIC half is mirrored here. This engine declares no language profiles, so
// every material file is in scope for its lenses and there is no "matched no profile" gap to
// report; what it does share with review.js is the pair of guards that stop a run which looked at
// nothing from returning a bare Approve.
// >>> craft-inline lib/review-coverage.mjs noChangedFilesMessage INERT_EXT INERT_NAMES GENERATED_PATH GENERATED_FILE isInertUncovered materialUncovered nothingToReviewMessage
// A diff that came back with NO files at all. Reachable legitimately — an already-merged branch, a
// `path` scope matching nothing — and also when detection half-failed, which is why this stays
// INCOMPLETE rather than green. But it is not a coverage hole: describing it with
// noLanguageMessage(0, 0) produced "none of the 0 changed file(s) … and 0 of them went unreviewed",
// a hole of size zero, which is self-contradictory and teaches readers to ignore the marker.
function noChangedFilesMessage() {
  return `NOTHING WAS REVIEWED — the diff came back EMPTY: no changed file was detected against the resolved base. Either there is genuinely nothing to review here (an already-merged branch, or a \`path\` scope that matches nothing) or the base/scope is wrong and detection failed. No lens ran, so this is not an approval — check the base and re-run.`
}

// Which unreviewed files actually lower the claim. Derived from the path alone and deliberately
// conservative: when in doubt a file is MATERIAL. A false "material" costs one honest INCOMPLETE
// marker; a false "inert" costs a silent overclaim, which is the bug this whole section exists to
// prevent. Three narrow exemptions only — prose/asset extensions, lockfiles matched by their real
// names, and artifacts whose path makes it unambiguous that a generator wrote them.
const INERT_EXT = /\.(md|markdown|rst|adoc|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf)$/i

const INERT_NAMES = new Set([
  'license', 'licence', 'notice', 'codeowners', '.gitignore', '.gitattributes',
  // Inert `.txt` files by NAME, not by extension. A blanket `.txt` rule was the lockfile bug again
  // in another costume: `CMakeLists.txt`, `requirements.txt`, `conanfile.txt` and `Dependencies.txt`
  // are build-system and dependency SOURCE, and a diff of nothing but those took the green
  // "nothing needed reviewing" return. When in doubt, material.
  'license.txt', 'licence.txt', 'notice.txt', 'copying.txt', 'authors.txt', 'contributors.txt',
  'changelog.txt', 'changes.txt', 'readme.txt', 'robots.txt', 'humans.txt', 'todo.txt', 'notes.txt',
  // Lockfiles, by the names they actually have. Matching a *shape* like `*lock.*` swallowed source
  // code — `db/lock.sql`, `src/lock.rs`, `internal/spin-lock.go` — and silently exempted it.
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'flake.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'go.sum', 'deno.lock', 'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json',
  'gradle.lockfile', 'cabal.project.freeze', 'conan.lock', 'herd.lock',
])

// Generated artifacts. Only where the PATH itself is unambiguous — a generator-stamped suffix or a
// directory whose whole purpose is generated output. A hand-written file never lives here.
const GENERATED_PATH = /(^|\/)(__generated__|generated|node_modules|vendor)\//i

const GENERATED_FILE = /(\.snap|\.min\.(js|css|mjs|cjs)|\.pb\.(go|cc|h|rs|ts)|_pb2(_grpc)?\.py|\.gen\.(go|rs|ts)|\.generated\.[a-z0-9]+|\.g\.dart)$/i

/** @param {unknown} f */
function isInertUncovered(f) {
  const base = /** @type {string} */ (String(f).split('/').pop()).toLowerCase()
  return INERT_EXT.test(String(f)) || INERT_NAMES.has(base) || GENERATED_PATH.test(String(f)) || GENERATED_FILE.test(String(f))
}

/** @param {unknown[]} files */
function materialUncovered(files) {
  return files.filter(f => !isInertUncovered(f))
}

// The other half of the no-profile case: a diff whose changed files are ALL inert (prose, assets,
// lockfiles, generated output). Nothing was reviewed AND nothing needed reviewing — a different
// statement from "files went unreviewed", and it must not be dressed up as a coverage hole. A
// marker that fires on every README-only change stops being read, which destroys the value of the
// marker on the diffs that do hide unreviewed code.
/** @param {number} fileCount */
function nothingToReviewMessage(fileCount) {
  return `NOTHING NEEDED REVIEWING — all ${fileCount} changed file(s) are documentation, assets, lockfiles or generated output; none carries reviewable code. No lens ran because none had anything to look at.`
}
// <<< craft-inline

// ================= Prep: scout + index warm-up (2 agents, parallel) =================
// `repo` is NOT supported by this engine: every agent it dispatches runs git/cargo wherever the
// session sits. Accepting it silently is the failure this family exists to end — the caller names
// another repository, the engine reads its own, and the verdict looks entirely normal for the wrong
// code (measured 2026-09-17 on `review`, before `repo` reached that engine's argument list: 57
// agents, 2.04M tokens, nothing reviewed). Refuse before anything runs, and name what does work.
// The comment above used to promise this argument while nothing read it (realm @nick/craft, #65).
// MOVED here from the argument block, and the move IS the fix. Refused up there it returned before
// `logRun` and its dependencies existed, so a repeatedly mis-dispatched engine filed no record at
// all — and `notRun` fragility ranking, which is the one place a repeated wrong dispatch would show
// up, never saw it. This is still before the first phase, so nothing has run when it refuses.
if (A['repo']) {
  const refused = repoRefusal({ engine: 'adversarial-review', repo: String(A['repo']), craftVersion: CRAFT_VERSION, outputTokens: budget.spent(), via: viaArg })
  await logRun(refused.record)
  return refused.report
}

/** @returns {string} the scout's instruction for resolving the diff base */
const scoutBaseStep = () => diffBase ? `Use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

phase('Prep')
const [scoutRaw, warmupRaw] = await parallel([
  () => agent(
    `You are scouting a diff to plan an adversarial review. Use shell + read only — do NOT review yet.
1. Resolve the diff base. ${scoutBaseStep()}
2. Inspect \`git diff --stat\` and list every touched path with \`git diff --name-only\` (same base) into changedFiles — complete and verbatim. sizeBucket: small = a few files / < ~80 changed lines; large = many files / > ~400 lines or auth/money/concurrency-heavy; medium otherwise.
3. lenses: choose from ${JSON.stringify(ALL_LENSES)}.
   - small: only the touched categories (minimum 2; always include 'correctness').
   - medium: the categories plausibly in play.
   - large: all of them.
   Decide "in play" from the diff: payments/amounts/ledger -> money; async/threads/locks/transactions -> concurrency; input parsing/auth/tenancy -> security; loops/queries -> performance; always consider 'correctness' and 'errors'. Include 'complexity' whenever the diff is medium/large (it self-skips if the repo is not indexed).`,
    { label: 'scout', schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low' },
  ),
  () => agent(
    `You are warming up the codebase-memory index for a review. Use ToolSearch to load the codebase-memory MCP tools.
1. Check list_projects / index_status for this repository.
2. If the project is not indexed or the index is stale relative to the current HEAD, run index_repository with mode=fast on the repo root and wait for it.
3. Return indexed=true only if a usable index exists when you are done. If the MCP server is unavailable, return indexed=false — never error.`,
    { label: 'index-warmup', schema: WARMUP_SCHEMA, effort: 'low' },
  ),
])
const scout = /** @type {ScoutResult | null} */ (scoutRaw)
const warmup = /** @type {WarmupResult | null} */ (warmupRaw)

/** @param {ScoutResult | null} scout @returns {string[]} the scout's lenses that are in the catalog, or every lens */
const scoutLenses = scout => (scout?.lenses?.length ? scout.lenses.filter((/** @type {string} */ l) => ALL_LENSES.includes(l)) : ALL_LENSES)
/**
 * The complexity lens is metrics-or-nothing: without a usable index it is dropped from the plan.
 * @param {{ lenses: string[] }} plan @param {WarmupResult | null} warmup
 */
function dropComplexityUnlessIndexed(plan, warmup) {
  if (!(warmup?.indexed)) {
    plan.lenses = plan.lenses.filter((/** @type {string} */ l) => l !== 'complexity')
    log(`codebase-memory index unavailable (${warmup?.notes ?? 'warm-up died'}) -> complexity lens dropped`)
  }
}
/** @param {ScoutResult | null} scout @param {WarmupResult | null} warmup */
function planReview(scout, warmup) {
  const plan = {
    baseRef: scout?.baseRef ?? diffBase,
    sizeBucket: scout?.sizeBucket ?? 'medium',
    lenses: scoutLenses(scout),
  }
  dropComplexityUnlessIndexed(plan, warmup)
  log(`Scout: ${plan.sizeBucket} diff -> lenses: ${plan.lenses.join(', ')} · ${scout?.notes ?? 'scout died, running all lenses'}`)
  return plan
}
const plan = planReview(scout, warmup)
/** @param {string[]} lenses @returns {{ size: string, lenses: string[], indexed: boolean, batch: number }} the record's `scout` field */
const scoutRecord = lenses => ({ size: plan.sizeBucket, lenses, indexed: !!(warmup?.indexed), batch: BATCH })

// ---- coverage guard: a run that looked at nothing must not report a green Approve ----
// The scout enumerates the diff; three outcomes have to be told apart, and only the third is a
// review. A dead scout is NOT an empty diff — it is an unknown one, so it opens `notRun` and the
// review proceeds over all lenses rather than short-circuiting to a verdict about nothing.
// A scout that came back WITHOUT a `changedFiles` array is the dead-scout case, not the empty-diff
// one: the list is unknown, not empty. Folding it into `!scout` also keeps the `: null` below from
// reaching `!changedFiles.length`, which threw a TypeError and aborted the run before any lens ran
// and before any run record was filed — the most permissive failure there is, an invisible one.
//
// Two things are recorded per entry, and they are not the same thing.
//   `label` goes in the RUN RECORD. `lib/analyze-runs.mjs` ranks `notRun` by EXACT STRING to
//   surface fragility that REPEATS across runs, so a label must be bare and aggregatable — no
//   counts, no lens lists, no file names. A note like "3 finder lens(es) never returned:
//   correctness, concurrency" is unique to its run and fills the ranking with count-1 rows,
//   sinking the real repeats. `lens:correctness` aggregates into `3× lens:correctness`.
//   `note` is the human sentence: it goes to the log and to the returned object, where it is read
//   once, by a person, about this run.
//   `incomplete` decides whether the entry downgrades the VERDICT. Not everything recorded here is
//   a coverage hole: a single verification check with no verdict, or coverage gaps skipped at the
//   budget floor, leave their findings reported as Suspected — already the honest label — and they
//   fire on routine runs. A marker that fires on every run stops being read, which is exactly what
//   would destroy it on the runs where a dimension really did go unreviewed. So those are recorded
//   (the fragility signal is kept) but advisory; only an unreviewed dimension downgrades. This is
//   the same line `review.js` draws: dead lenses and skipped critics mark INCOMPLETE, individual
//   unverified checks do not.
/** @type {{ label: string, note: string, incomplete: boolean }[]} */
const notRun = []
/** @type {(label: string, note: string, incomplete?: boolean) => number} */
const markNotRun = (label, note, incomplete = true) => notRun.push({ label, note, incomplete })
const notRunLabels = () => notRun.map(e => e.label)
const notRunNotes = () => notRun.map(e => e.note)
const notRunBlocking = () => notRun.filter(e => e.incomplete)
const runThrottled = makeThrottledRunner({
  agent, parallel, log, markNotRun,
  batch: BATCH, retryBatch: RETRY_BATCH, maxRetryRounds: MAX_RETRY_ROUNDS,
  budget, budgetFloor: BUDGET_FLOOR,
})
/**
 * Files the record of a run that ended before any lens ran.
 * @param {string} verdict @param {string[]} labels  its notRun classes
 */
async function fileEarlyExit(verdict, labels) {
  await logRun({
    ...recordHead(),
    verdict, findings: summarizeFindings([]),
    scout: scoutRecord([]),
    dimensions: [], verification: { candidates: 0, confirmed: 0, refuteRate: 0 },
    notRun: labels, outputTokens: budget.spent(),
  })
}

/**
 * An INCOMPLETE early exit: logged, filed under its one notRun class, and returned with its message.
 * @param {string} verdict @param {string} label @param {string} msg
 */
async function incompleteExit(verdict, label, msg) {
  log(`INCOMPLETE — ${msg}`)
  await fileEarlyExit(verdict, [label])
  return { verdict, confirmed: [], suspected: [], notRun: [msg].concat(telemetryNotes()), scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] } }
}

/** @returns {string} the cross-check's instruction for resolving the diff base */
const crossBaseStep = () => diffBase ? `The caller pinned it: use \`${diffBase}\`.` : 'Try in order: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'

/**
 * Why the cross-check does not confirm the scout's all-inert list, or null when it does.
 * @param {CrosscheckResult | null} cross @param {string[]} changedFiles @returns {string | null}
 */
function inertDisagreement(cross, changedFiles) {
  const crossFiles = (cross?.ok && Array.isArray(cross.files)) ? cross.files.filter(isPath) : null
  // Read only where `crossFiles` is set, and that implies a live `cross`.
  const crossCount = cross?.fileCount
  if (!crossFiles) return 'the cross-check never returned a usable list'
  if (crossFiles.length !== crossCount) return `the cross-check list is incomplete (${crossFiles.length} paths vs ${crossCount} reported by git)`
  if (crossFiles.length !== changedFiles.length) return `git reports ${crossFiles.length} changed file(s), the scout reported ${changedFiles.length}`
  if (materialUncovered(crossFiles).length) return `git's list contains reviewable code the scout did not report: ${materialUncovered(crossFiles).join(', ')}`
  return null
}

// All inert (docs/assets/lockfiles/generated). Nothing ran AND nothing needed to — an honest
// green, deliberately not marked INCOMPLETE: a marker that fires on every README-only change
// stops being read on the diffs that do hide unreviewed code.
//
// But this is the ONE exit where a green rests entirely on the scout's file list, and that list
// comes from a model, not from `git`. A scout that truncated, globbed, or resolved the wrong base
// and happened to emit only docs and lockfiles would approve a real code diff. The script itself
// has no shell (the Workflow sandbox has no filesystem or Node API), so the deterministic route
// is a second, single-purpose agent that does nothing but transcribe `git diff --name-only`. It
// is cheap and only fires on this branch. The green is taken only if that independent list is
// complete by its own `wc -l`, agrees with the scout's size, and is itself entirely inert;
// anything else — including a dead cross-check — falls back to INCOMPLETE.
//
// The base is resolved INDEPENDENTLY, not taken from `plan.baseRef`. Pinning the cross-check to
// the scout's own base would leave the wrong-base case structurally invisible — both agents would
// diff the same wrong ref, agree perfectly, and the green would be granted. Resolving it again
// from the same deterministic ladder turns a wrong base into a differing file list, which the
// comparison below already catches. Only an explicit `diffBase` argument is passed through: there
// the base is the caller's, not the scout's, so there is nothing to cross-check.
//
// What this still does NOT catch: `fileCount` and `files` come from the same model in the same
// response, so the self-consistency arm is self-reported — a model that truncates the list AND
// lowers its own count to match defeats it. What that arm actually rules out is the ordinary
// failure (a list shortened while the count stays honest), not a coordinated one.
/** @param {string[]} changedFiles  the scout's list, every path inert */
async function inertExit(changedFiles) {
  const cross = /** @type {CrosscheckResult | null} */ (await agent(
    `You are cross-checking a diff's file list. Run shell only — do NOT review, summarise, or judge anything.
1. Resolve the diff base YOURSELF — do not take it from anyone else. ${crossBaseStep()}
2. Run \`git diff --name-only <base>\` and \`git diff --name-only <base> | wc -l\`.
3. Return every path VERBATIM in \`files\` — no truncation, no globbing, no sorting, no elision — and the \`wc -l\` number in \`fileCount\`.
4. Set ok=true ONLY if the git command succeeded and \`files\` holds every path it printed. If anything failed, or you had to shorten the list for any reason, set ok=false.`,
    { label: 'inert-crosscheck', phase: 'Prep', schema: CROSSCHECK_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  const why = inertDisagreement(cross, changedFiles)
  if (why) {
    return await incompleteExit('INCOMPLETE (unconfirmed inert diff)', 'inert-diff-unconfirmed',
      `NOT REVIEWED — the scout said every changed file was inert (docs/assets/lockfiles/generated), but ${why}. The scout's file list is the only thing that green rested on, so it is not granted: no lens ran, and this is not an approval. Re-run, checking the diff base.`)
  }
  const msg = nothingToReviewMessage(changedFiles.length)
  log(msg)
  await fileEarlyExit('Approve', [])
  return { verdict: 'Approve', confirmed: [], suspected: [], notRun: telemetryNotes(), summary: msg, scout: { size: plan.sizeBucket, lenses: [], deadLenses: [] } }
}

/**
 * Tells apart the scout's three outcomes: an unknown diff (opens notRun; the review proceeds), an
 * empty one and an all-inert one (both end the run here). Returns the early result, or null to review.
 * @param {ScoutResult | null} scout
 */
async function coverageGuard(scout) {
  const changedFiles = Array.isArray(scout?.changedFiles) ? scout.changedFiles.filter(isPath) : null
  if (!scout || !changedFiles) {
    markNotRun('scout-dead', scout
      ? 'the scout returned no file list — the diff was never enumerated, so what the lenses saw is unverified'
      : 'scout died — the diff was never enumerated, so what the lenses saw is unverified')
    return null
  }
  if (!changedFiles.length) return await incompleteExit('INCOMPLETE (empty diff)', 'empty-diff', noChangedFilesMessage())
  if (!materialUncovered(changedFiles).length) return await inertExit(changedFiles)
  return null
}
const early = await coverageGuard(scout)
if (early) return early

// ================= Review: throttled finder lenses =================
/**
 * Lenses whose answer came back and is not a review, marked not-run one entry per lens.
 * @param {string[]} lenses @param {Map<string, FindingsResult | null>} lensResults @returns {string[]}
 */
function markMalformedLenses(lenses, lensResults) {
  // A result is model output: the schema is enforced by the tool, but a lens that came back without a
  // findings array is a lens that did not review, not one that found nothing — and must not crash the run.
  // It is dead for every consumer of `deadLenses` (the all-dead check, the critic's prompt, the returned
  // scout), not only for `notRun`.
  const malformedLenses = lenses.filter((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r != null && !Array.isArray(r.findings)
  })
  if (malformedLenses.length) {
    log(`WARNING: finder lens(es) answered without a findings array: ${malformedLenses.join(', ')}`)
    for (const l of malformedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens returned no findings array — that dimension went unreviewed`)
  }
  return malformedLenses
}

/**
 * Runs the finder lenses throttled; returns every finding tagged with its lens, and the lenses that
 * did not review (died, or answered without a findings array).
 * @param {string[]} lenses
 */
async function runFinderLenses(lenses) {
  /** @type {Map<string, FindingsResult | null>} */
  const lensResults = new Map()
  const deadLensJobs = await runThrottled(
    lenses.map((/** @type {string} */ lens) => ({
      prompt: finderPrompt(lens),
      label: `review:${lens}`,
      schema: FINDINGS,
      effort: 'medium',
      onResult: (/** @type {unknown} */ r) => lensResults.set(lens, /** @type {FindingsResult | null} */ (r)),
    })),
    'Review', 'Review', { reportUnjudged: false },
  )
  const diedLenses = deadLensJobs.map(j => j.label.replace(/^.*review:/, ''))
  if (diedLenses.length) {
    log(`WARNING: finder lens(es) returned nothing: ${diedLenses.join(', ')}`)
    // One entry PER dead lens: `lens:correctness` is what aggregates across runs into
    // "3× lens:correctness", which is the whole point of ranking `notRun`.
    for (const l of diedLenses) markNotRun(`lens:${l}`, `the ${l} finder lens never returned — that dimension went unreviewed`)
  }
  const malformedLenses = markMalformedLenses(lenses, lensResults)
  /** @type {string[]} */
  const deadLenses = [...new Set([...diedLenses, ...malformedLenses])]
  if (lenses.length && deadLenses.length === lenses.length) markNotRun('all-lenses-dead', 'EVERY finder lens died — no lens looked at this diff at all')

  const all = lenses.flatMap((/** @type {string} */ lens) => {
    const r = lensResults.get(lens)
    return r && Array.isArray(r.findings) ? r.findings.map(x => ({ ...x, lens })) : []
  })
  return { deadLenses, all }
}

phase('Review')
const { deadLenses, all } = await runFinderLenses(plan.lenses)

// ---- dedup, tier 1 (mechanical): neighbor line-buckets + title-token similarity ----
// Merging requires BOTH nearby lines (|Δ| <= 5, buckets k-1..k+1 so bucket borders don't split)
// AND similar titles — proximity alone never merges, so two distinct issues in one window
// survive as two findings. Under-merge costs one cheap verify agent; over-merge silently
// loses a finding — stay conservative.
const normTokens = (/** @type {unknown} */ t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').split(' ').filter(w => w.length > 2))
/** @param {unknown} a @param {unknown} b */
function titleSimilar(a, b) {
  const tokensA = normTokens(a), B = normTokens(b)
  if (!tokensA.size || !B.size) return false
  let inter = 0
  for (const w of tokensA) if (B.has(w)) inter++
  return inter / (tokensA.size + B.size - inter) > 0.5
}
/**
 * The first entry in bucket b-1, b or b+1 of the finding's file that lies within 5 lines and has a similar title.
 * @param {Map<string, LensFinding[]>} buckets @param {RawFinding} f @param {number} b @returns {LensFinding | null}
 */
function nearbySimilar(buckets, f, b) {
  for (const nb of [b - 1, b, b + 1]) {
    for (const e of (buckets.get(`${f.file}:${nb}`) || [])) {
      if (Math.abs(e.line - f.line) <= 5 && titleSimilar(e.title, f.title)) return e
    }
  }
  return null
}
/**
 * Folds a duplicate into the entry it hit: its lens joins the sources, and a more severe duplicate's wording wins.
 * @param {LensFinding} hit @param {RawFinding & { lens: string }} f
 */
function absorbDuplicate(hit, f) {
  if (!hit.sources.includes(f.lens)) hit.sources.push(f.lens)
  if (SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (f.severity)] < SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (hit.severity)]) {
    Object.assign(hit, { title: f.title, line: f.line, severity: f.severity, description: f.description, fix: f.fix, lens: f.lens })
  }
}
/** @param {(RawFinding & { lens: string })[]} all @returns {LensFinding[]} the pool after mechanical dedup, most severe first */
function mechanicalDedup(all) {
  /** @type {Map<string, LensFinding[]>} */
  const buckets = new Map()   // `${file}:${bucket}` -> entries in that bucket
  /** @type {LensFinding[]} */
  const merged = []
  for (const f of all) {
    const b = Math.floor(f.line / 10)
    const hit = nearbySimilar(buckets, f, b)
    if (hit) {
      absorbDuplicate(hit, f)
      continue
    }
    const entry = { ...f, sources: [f.lens] }
    merged.push(entry)
    const key = `${f.file}:${b}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  return merged.sort((a, b) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (a.severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (b.severity)])
}
let kept = mechanicalDedup(all)
log(`Review: ${all.length} raw findings -> ${kept.length} after mechanical dedup`)

// ---- dedup, tier 2 (semantic, thresholded): one haiku clusterer for cross-vocabulary duplicates ----
// Catches what token overlap can't: different lenses describing one defect in different words
// ("TOCTOU at debit" vs "race on balance update"). Runs only on large pools where duplicates
// are likely; merges keep BOTH formulations so an over-eager merge degrades to a verbose
// description instead of a lost finding.
const DEDUP_THRESHOLD = 15
/** @returns {boolean} whether the budget still allows spawning agents (an unlimited one always does) */
const budgetAllows = () => !budget.total || budget.remaining() > BUDGET_FLOOR
/**
 * Merges each cluster's duplicates into its most severe member, keeping both formulations.
 * @param {LensFinding[]} kept @param {number[][]} clusters @returns {Set<number>} the indices merged away
 */
function mergeClusters(kept, clusters) {
  /** @type {Set<number>} */
  const drop = new Set()
  // Only ever called with an index the filter below has bounded to `kept`.
  const at = (/** @type {number} */ i) => /** @type {LensFinding} */ (kept[i])
  for (const cluster of clusters) {
    const idxs = [...new Set(Array.isArray(cluster) ? cluster : [])]
      .filter(i => Number.isInteger(i) && i >= 0 && i < kept.length && !drop.has(i))
      .sort((x, y) => SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(x).severity)] - SEV_RANK[/** @type {keyof typeof SEV_RANK} */ (at(y).severity)])
    if (idxs.length < 2) continue
    const head = at(/** @type {number} */ (idxs[0]))
    for (const i of idxs.slice(1)) {
      mergeDuplicate(head, at(i))
      drop.add(i)
    }
  }
  return drop
}
/** @param {LensFinding} head @param {LensFinding} dup */
function mergeDuplicate(head, dup) {
  for (const s of dup.sources) if (!head.sources.includes(s)) head.sources.push(s)
  head.description += `\n[merged duplicate] ${dup.title} @ ${dup.file}:${dup.line}: ${dup.description}`
}
/** @param {LensFinding[]} kept @returns {Promise<LensFinding[]>} the pool after the semantic clusterer, or `kept` itself when it merged nothing */
async function semanticDedup(kept) {
  const CLUSTERS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['clusters'],
    properties: {
      clusters: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, description: 'indices of findings that are the SAME defect' },
        description: 'only groups of 2+; singletons are omitted; empty if no duplicates',
      },
    },
  }
  const clusterer = /** @type {ClustersResult | null} */ (await agent(
    `You are deduplicating review findings. Below is a numbered list. Return clusters of indices that describe THE SAME underlying defect — same root cause, one fix would resolve all of them — even when phrased in different vocabulary or cited at nearby-but-different lines (e.g. a check-site vs a write-site of one race).
Merge ONLY when confident the fix is literally the same change. Two different problems in the same function are NOT a cluster. When in doubt, do not merge. Return {"clusters": []} if there are no duplicates.

FINDINGS:
${kept.map((f, i) => `${i}. [${f.severity}] ${f.title} @ ${f.file}:${f.line} (lenses: ${f.sources.join(',')}) — ${f.description}`).join('\n')}`,
    { label: 'dedup-semantic', phase: 'Review', schema: CLUSTERS_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  // Model output: a live clusterer whose `clusters` is not an array merged nothing — say so, never throw.
  const clusters = Array.isArray(clusterer?.clusters) ? clusterer.clusters : []
  if (clusterer && !Array.isArray(clusterer.clusters)) log('WARNING: semantic dedup returned clusters that are not an array — no semantic merge applied')
  const drop = mergeClusters(kept, clusters)
  if (!drop.size) {
    log('Semantic dedup: no cross-vocabulary duplicates found')
    return kept
  }
  const rest = kept.filter((_f, i) => !drop.has(i))
  log(`Semantic dedup: merged ${drop.size} duplicate(s) -> ${rest.length} findings`)
  return rest
}
if (kept.length > DEDUP_THRESHOLD && budgetAllows()) kept = await semanticDedup(kept)

// ================= Verify =================
phase('Verify')
const COMBINED_INSTR = `You are an adversarial verifier. Try to REFUTE this finding. Check ALL THREE dimensions in one pass:
1. code — is the claim factually true in the code as written? Read the actual code; do not trust the description.
2. exploit — construct a concrete end-to-end scenario that triggers the issue. If you cannot, that counts against the finding.
3. severity — calibrate real impact for the multi-tenant money-path, and confirm the issue is in scope for THIS diff.
Return refuted=true if ANY dimension fails. Default to refuted=true when uncertain. Return the calibrated severity.
Also set premiseSupported: identify the ONE claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the finding's whereChecked location and check it actually shows that; premiseSupported=false when the premise is off-site and whereChecked is empty, points elsewhere, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it; the field demotes the finding on its own.`
const COMBINED_METRIC_INSTR = `You are an adversarial verifier for a METRIC-BACKED complexity finding.
Use ToolSearch to load the codebase-memory MCP tools. Check ALL THREE dimensions:
1. metric — re-read the metric values yourself via query_graph; refute if they don't match the claim or the index is unavailable.
2. attribution — confirm THIS diff introduced or worsened the metric (compare against detect_changes); pre-existing debt misattributed to the diff -> refute or downgrade.
3. severity — calibrate real impact: is the function on a hot / caller-reachable path (trace_path), or dead-end cold code?
Return refuted=true if ANY dimension fails; default to refuted=true when uncertain.
Also set premiseSupported: true when you re-read the metric values yourself and they back the claim, false when the numbers came only from the finding's own description. Unsupported is NOT disproven — it demotes the finding without marking it refuted.`
/** @type {[string, string][]} */
const PANEL_LENSES = [
  ['code', 'Verify ONLY the factual claim against the code as written. Read the code yourself; refute if the description misstates it.'],
  ['exploit', 'Try to construct a concrete end-to-end exploit/trigger scenario. Refute if no realistic path exists.'],
  ['severity', 'Calibrate real-world severity for the multi-tenant money-path and check the issue is in scope for this diff. Refute if severity is inflated or out of scope.'],
]

// Builds verify jobs for a set of findings, writing votes into `sink[idx]`.
// Single combined verifier (effort low) for medium/low; 3-lens panel (effort high)
// for critical/high; metric-aware single verifier for complexity findings.
/**
 * @param {LensFinding[]} findings
 * @param {unknown[][]} sink  per-finding raw votes, one slot per finding
 */
function buildVerifyJobs(findings, sink) {
  /** @type {Parameters<typeof runThrottled>[0]} */
  const jobs = []
  // `sink` is built as one array per finding, so `idx` from `findings.forEach` always has a slot.
  const slot = (/** @type {number} */ idx) => /** @type {unknown[]} */ (sink[idx])
  findings.forEach((f, idx) => {
    const ctx = `FINDING [${f.severity}] ${f.title} @ ${f.file}:${f.line}\n` +
      `Independently reported by lenses: ${(f.sources || [f.lens]).join(', ')}\n${f.description}\nProposed fix: ${f.fix}\n` +
      `Off-site evidence claimed: ${f.whereChecked || '(none — the finding claims to be self-contained at the cited line)'}`
    /** @type {(lens: string, instr: string, effort: 'low' | 'high', tagged: boolean) => number} */
    const push = (lens, instr, effort, tagged) => jobs.push({
      prompt: `${instr}\n\n${ctx}`,
      label: `verify${tagged ? `[${lens}]` : ''}:${f.file}:${f.line}`,
      schema: VERDICT,
      effort,
      onResult: (/** @type {unknown} */ v) => slot(idx).push({ lens, .../** @type {VerdictResult | null} */ (v) }),
      // A check that never returned leaves a placeholder, so the judge can SEE the panel is short.
      // Without it a 3-lens panel that lost one member is indistinguishable from a 2-lens panel.
      onMissing: () => slot(idx).push({ lens, missing: true }),
    })
    if (f.lens === 'complexity') push('metric', COMBINED_METRIC_INSTR, 'low', true)
    else if (isEscalated(f)) for (const [lens, instr] of PANEL_LENSES) push(lens, instr, 'high', true)
    else push('combined', COMBINED_INSTR, 'low', false)
  })
  return jobs
}

// >>> craft-inline lib/adversarial-judge.mjs usableVote judgeVotes
// A verdict object we cannot read is not a verdict. `onResult` spreads whatever the agent returned
// (`{...true}` and `{...{}}` both yield an object with none of the fields), and this engine already
// records a live agent returning WITHOUT a schema-`required` field — so `required` in the schema is
// not a guarantee. Unread fields would otherwise vote: a missing `refuted` counts as non-refuting, a
// missing `premiseSupported` as non-supporting, and an `undefined` severity survives into the median
// where `SEV_RANK[undefined]` makes the comparator NaN and the confirmed finding can come out with no
// severity at all — which `baseVerdict` reads as neither critical nor high, i.e. Approve.
/**
 * @param {unknown} v  an agent-returned verdict object of unknown shape (model output)
 * @param {Record<string, number>} SEV_RANK
 * @returns {v is Vote}
 */
function usableVote(v, SEV_RANK) {
  if (!v || typeof v !== 'object') return false
  const o = /** @type {{ refuted?: unknown, premiseSupported?: unknown, severity?: unknown }} */ (v)
  return typeof o.refuted === 'boolean'
    && typeof o.premiseSupported === 'boolean'
    && (o.severity === 'not-an-issue' || SEV_RANK[/** @type {string} */ (o.severity)] != null)
}

/**
 * The findings come back as they went in — the caller's own type — with the judge's verdict fields added.
 * @template {{ severity: string }} F
 * @param {F[]} findings
 * @param {Array<unknown[] | undefined>} sink  per-finding raw votes (model output, possibly malformed or `{ missing: true }`)
 * @param {Record<string, number>} SEV_RANK
 */
function judgeVotes(findings, sink, SEV_RANK) {

  // Severity is the THIRD decision axis, and the one that produces the verdict: `baseVerdict` reads
  // Block from a confirmed critical/high, Warning from a medium, Approve otherwise. So the absent
  // vote must be asked the same question here as on the other two — and it was not, which is how a
  // dead lens turned Block into Approve while both other axes agreed and nothing was flagged.
  // The median is taken over the FULL panel: a panel of three whose members voted [high, low] and
  // lost one has median index 1 of TWO, i.e. the milder — absence pulling severity down.
  /** @type {(sev: string) => number} */
  const rankOf = sev => /** @type {number} */ (SEV_RANK[sev])
  const ranks = Object.keys(SEV_RANK).sort((a, b) => rankOf(a) - rankOf(b))
  const MOST = /** @type {string} */ (ranks[0])
  const LEAST = /** @type {string} */ (ranks[ranks.length - 1])
  // Which side of the verdict this severity falls on. Comparing TIERS, not severities, keeps the
  // marker narrow: critical vs high both mean Block, and flagging that as undecided would fire on
  // runs where the absence changed nothing — a false INCOMPLETE is no safer here than a false clean.
  /** @type {(sev: string) => 'block' | 'warning' | 'approve'} */
  const tierOf = sev => (rankOf(sev) <= rankOf('high') ? 'block' : sev === 'medium' ? 'warning' : 'approve')
  /** @type {(f: F, votes: Vote[], missing: number, pad: string) => string} */
  const calibrateWith = (f, votes, missing, pad) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity)
      .concat(Array.from({ length: missing }, () => pad))
      .sort((a, b) => rankOf(a) - rankOf(b))
    return sevs.length ? /** @type {string} */ (sevs[Math.floor(sevs.length / 2)]) : f.severity
  }
  // The absent votes padded with what the FINDER claimed — a neutral stand-in, where their silence
  // was not. Only used once the two extremes agree that the verdict cannot swing either way.
  /** @type {(f: F, votes: Vote[], missing: number) => string} */
  const calibrate = (f, votes, missing) => calibrateWith(f, votes, missing, f.severity)
  // Malformed votes become absences, so the two-assignment machinery below decides them rather than
  // letting an unreadable object count as a non-refuting, non-supporting, severity-less confirmation.
  /** @type {(raw: unknown[] | undefined) => Array<Vote | { lens?: unknown, missing: true }>} */
  const readVotes = raw => (raw || []).map(v => (usableVote(v, SEV_RANK) && !v.missing) ? v : { lens: v && /** @type {{ lens?: unknown }} */ (v).lens, missing: true })
  // A missing vote must not decide — but "missing" is not the same as "undecidable". Ask what the
  // absent votes COULD have changed, and only fall back when they could have changed the answer.
  // Both traps are real and both were measured on this engine:
  //   [refute, confirm, confirm] confirms; losing one confirming lens made `refutes * 2 < votes`
  //     false, so the SAME finding was filed as refuted — and refuted findings never reach the
  //     report, they are fed forward as "adversarially disproven, do not re-report".
  //   Demoting on ANY absence is the inverse trap: [confirm, confirm, missing] cannot change —
  //     even a refuting third vote leaves 1*2 < 3 — so demoting it to Suspected drops a critical
  //     finding out of `confirmed`, and the verdict is built from `confirmed` alone. A silent
  //     Approve, in place of the Block that two independent lenses had earned.
  /** @type {(panel: number, votes: Vote[], missing: number) => { refuteUndecided: boolean, survives: boolean }} */
  const refuteAxis = (panel, votes, missing) => {
    const refutes = votes.filter(v => v.refuted).length
    // The two extreme assignments of the absent votes. They agree → the absence changes nothing and
    // the answer stands; they disagree → the absent vote is the deciding one, and nobody cast it.
    const survivesIfAbsentRefute = votes.length > 0 && (refutes + missing) * 2 < panel
    const survivesIfAbsentConfirm = votes.length > 0 && refutes * 2 < panel
    const refuteUndecided = survivesIfAbsentRefute !== survivesIfAbsentConfirm
    return { refuteUndecided, survives: !refuteUndecided && survivesIfAbsentRefute }
  }
  // An off-site premise no verifier could pin to real code is UNSUPPORTED, not disproven. It costs
  // the finding its Confirmed tier, but it must NOT be filed as refuted: the refuted list is fed
  // back to the next round as "adversarially disproven — do not re-report", which would bury a
  // possibly-real finding for the rest of the run over a missing citation.
  // The SAME two-assignment question is asked here. Resolving the absence pessimistically on this
  // axis ("assume the missing vote did not support") looks conservative and is not: it drops the
  // finding out of `confirmed`, the verdict is built from `confirmed` alone, and the run prints a
  // bare Approve — a missing vote deciding a critical finding, in the permissive direction, which
  // is the whole defect. `premiseSupported` is a required verifier field and a 1-1 split on a
  // 3-lens panel is an ordinary outcome, not a corner case.
  /** @type {(panel: number, votes: Vote[], missing: number, survives: boolean) => { premiseUndecided: boolean, premiseUnsupported: boolean }} */
  const premiseAxis = (panel, votes, missing, survives) => {
    const supported = votes.filter(v => v.premiseSupported).length
    const unsupportedIfAbsentUnsupported = supported * 2 <= panel
    const unsupportedIfAbsentSupported = (supported + missing) * 2 <= panel
    const premiseUndecided = survives && unsupportedIfAbsentUnsupported !== unsupportedIfAbsentSupported
    return { premiseUndecided, premiseUnsupported: survives && !premiseUndecided && unsupportedIfAbsentUnsupported }
  }
  /** @type {(f: F, votes: Vote[], missing: number, open: boolean) => boolean} */
  const severityAxisUndecided = (f, votes, missing, open) => open && missing > 0
    && tierOf(calibrateWith(f, votes, missing, MOST)) !== tierOf(calibrateWith(f, votes, missing, LEAST))
  // `undecidedByAbsence` is the honest label for "nobody decided this": it is what a caller must
  // surface in the VERDICT, because a finding parked in Suspected does not downgrade anything.
  // What the run would have printed had the absent votes come back at their worst. The caller must
  // gate its blocking entry on THIS, not on the finder's own label: the finder's severity and lens
  // are what shaped the panel, not what the verdict would have been. A single verifier can calibrate
  // a `medium` finding up to `critical`, and a `high` complexity finding gets one verifier and no
  // panel — both are "nobody decided this, and deciding it would have blocked the run".
  /** @type {(f: F, votes: Vote[], missing: number, undecided: boolean) => { undecidedByAbsence: boolean, couldHaveBlocked: boolean }} */
  const absenceOutcome = (f, votes, missing, undecided) => {
    const undecidedByAbsence = missing > 0 && (undecided || votes.length === 0)
    const reachable = votes.length ? calibrateWith(f, votes, missing, MOST) : MOST
    // Only meaningful on a finding nobody decided: on a decided one the answer is the answer.
    return { undecidedByAbsence, couldHaveBlocked: undecidedByAbsence && tierOf(reachable) === 'block' }
  }
  const judged = findings.map((f, idx) => {
    const all = readVotes(sink[idx])
    const missing = all.filter(v => v.missing).length
    const votes = /** @type {Vote[]} */ (all.filter(v => !v.missing))
    const { refuteUndecided, survives } = refuteAxis(all.length, votes, missing)
    const { premiseUndecided, premiseUnsupported } = premiseAxis(all.length, votes, missing, survives)
    const severityUndecided = severityAxisUndecided(f, votes, missing, survives && !premiseUnsupported)
    const undecided = refuteUndecided || premiseUndecided || severityUndecided
    const confirmed = survives && !premiseUnsupported && !premiseUndecided && !severityUndecided
    const { undecidedByAbsence, couldHaveBlocked } = absenceOutcome(f, votes, missing, undecided)
    return { ...f, confirmed, premiseUnsupported, couldHaveBlocked, undecidedByAbsence, votes, severity: confirmed ? calibrate(f, votes, missing) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    // `degraded` is excluded here for the same reason `premiseUnsupported` is: the refuted list is
    // fed forward as "do NOT re-report — adversarially disproven", and a panel that never finished
    // disproved nothing. It falls to Suspected, which is what the not-run note has always claimed.
    refuted: judged.filter(v => !v.confirmed && !v.premiseUnsupported && !v.undecidedByAbsence && v.votes.length > 0),
    suspected: judged.filter(v => v.undecidedByAbsence || v.votes.length === 0 || v.premiseUnsupported),
  }
}
// <<< craft-inline
/** @template {LensFinding} F @param {F[]} findings @param {Parameters<typeof judgeVotes>[1]} sink */
const judge = (findings, sink) => judgeVotes(findings, sink, SEV_RANK)

/** @type {unknown[][]} */
const votes = kept.map(() => [])
const verifyJobs = buildVerifyJobs(kept, votes)
log(`Verify plan: ${kept.length} findings -> ${verifyJobs.length} checks (${kept.filter(isEscalated).length} escalated to 3-lens panel), throttled to ${BATCH} concurrent`)
// `runThrottled` records the unjudged checks in `notRun` itself (advisory) — see the region above.
/** @param {unknown[]} unverified */
const warnUnverified = unverified => { if (unverified.length) log(`WARNING: ${unverified.length} checks got no verdict after retries`) }
warnUnverified(await runThrottled(verifyJobs, 'Verify', 'Verify'))

const judged = judge(kept, votes)
let { confirmed, refuted } = judged
// Wider than the judge's own output: coverage gaps left unverified at the budget floor join this list
// as they are, with no panel and none of the judge's per-finding flags.
/** @type {Array<(typeof judged.suspected)[number] | (LensFinding & { confirmed: false, votes: never[] })>} */
let suspected = judged.suspected
log(`Verify done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${suspected.length} suspected (no verdict)`)
// A finding nobody decided must reach the VERDICT, not only the Suspected list. Suspected downgrades
// nothing — `baseVerdict` is computed from `confirmed` alone — so a run in which every escalated
// finding lost the one panel member that would have decided it prints a bare `Approve`, identical to
// a run whose panels all voted and cleared them. Blocking, and narrow: it needs an escalated
// (critical/high) finding whose absent vote was the deciding one, which is the exact case where the
// engine cannot say whether this run should have blocked.
// Gated on what the absent vote could have DECIDED, never on the finder's label. `isEscalated` reads
// the finder's severity and lens — the fields that shaped the panel — and both of its clauses leak
// here: a complexity finding is excluded by lens although the lens emits `high` and gets a single
// verifier, and a `medium` finding is excluded by severity although one verifier can calibrate it to
// `critical`. The judge computes the reachable tier instead.
/** @param {typeof judged} j */
function markUndecidedEscalated(j) {
  const undecidedEscalated = [...j.confirmed, ...j.refuted, ...j.suspected].filter(f => f.undecidedByAbsence && f.couldHaveBlocked)
  if (undecidedEscalated.length) {
    markNotRun('escalated-findings-undecided', `${undecidedEscalated.length} critical/high finding(s) lost the panel vote that would have decided them — this run cannot say whether it should have blocked`)
  }
}
markUndecidedEscalated(judged)

// ================= Coverage: critic, then verify its gaps through the same pipeline =================
/**
 * The completeness critic (retried once), and its gaps tagged as coverage findings; a critic that died
 * twice or answered without a findings array is not-run and yields no gaps.
 * @param {{ title: string, file: string, line: number }[]} confirmed @param {{ title: string, file: string, line: number }[]} refuted
 * @returns {Promise<LensFinding[]>}
 */
async function criticGaps(confirmed, refuted) {
  const CRITIC_PROMPT = `You are a completeness critic for an adversarial diff review (diff base: ${plan.baseRef || 'HEAD'}).
Ask: what is MISSING — a changed file no finding touched, a category of bug not checked, a dimension left uncovered?
Report each gap as a concrete located finding (file:line of the suspicious spot, severity, description, fix).
CONFIRMED findings (do not repeat them): ${JSON.stringify(confirmed.map(f => `${f.title} @ ${f.file}:${f.line}`))}
REFUTED claims (do NOT re-report these — they were adversarially disproven): ${JSON.stringify(refuted.map(f => `${f.title} @ ${f.file}:${f.line}`))}
Dead lenses this run (their dimension is UNCOVERED — look there first): ${JSON.stringify(deadLenses)}
If coverage is complete, return {"findings": []}.`
  let critic = /** @type {FindingsResult | null} */ (await agent(CRITIC_PROMPT, { label: 'coverage-critic', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  if (!critic) {
    log('Coverage critic failed, retrying once')
    critic = /** @type {FindingsResult | null} */ (await agent(CRITIC_PROMPT, { label: 'coverage-critic-retry', phase: 'Coverage', schema: FINDINGS, effort: 'high' }))
  }
  if (!critic) {
    // Without this the critic's silence is indistinguishable from "coverage is complete": `?? []`
    // below yields zero gaps, and a diff whose blind spots were never looked for reads as covered.
    log('WARNING: coverage critic died twice — completeness was never checked')
    markNotRun('coverage-critic-dead', 'the coverage critic died twice — no completeness check ran, so blind spots in this review are unknown')
  }

  // A live critic whose `findings` is not an array checked nothing we can read — that is not-run under
  // its own label, never a silent "coverage is complete" and never a crash.
  if (critic && !Array.isArray(critic.findings)) {
    log('WARNING: coverage critic answered without a findings array — completeness was never checked')
    markNotRun('coverage-critic-malformed', 'the coverage critic answered without a findings array — no usable completeness check ran, so blind spots in this review are unknown')
  }
  // Critic findings do not bypass verification — they ride the same throttled pipeline.
  return (critic && Array.isArray(critic.findings) ? critic.findings : []).map(f => ({ ...f, lens: 'coverage', sources: ['coverage'] }))
}
phase('Coverage')
const gaps = await criticGaps(confirmed, refuted)

/**
 * Verifies the critic's gaps through the same pipeline, or — below the budget floor — reports them
 * as suspected; returns the confirmed and suspected lists with the gaps' outcome folded in.
 * @param {LensFinding[]} gaps @param {typeof confirmed} found @param {typeof suspected} doubtful
 */
async function withGapVerdicts(gaps, found, doubtful) {
  if (gaps.length && budgetAllows()) {
    log(`Coverage critic raised ${gaps.length} gap(s) -> verifying through the same pipeline`)
    /** @type {unknown[][]} */
    const gapVotes = gaps.map(() => [])
    // Opts out of the runner's advisory entry and marks its own BLOCKING one, for the reason the
    // budget-floor branch below spells out: a coverage gap is the critic's claim that something went
    // UNREVIEWED. Crossing the budget floor midway through this pass leaves exactly the same blind
    // spots unopened as failing to start it, so the two must land on the same side of the line —
    // otherwise the identical run reads `Approve` or `Approve (INCOMPLETE)` depending only on which
    // side of the first batch the floor happened to fall. Same label, so analyze-runs aggregates both.
    const unverifiedGapJobs = await runThrottled(buildVerifyJobs(gaps, gapVotes), 'Coverage-verify', 'Coverage', { reportUnjudged: false })
    if (unverifiedGapJobs.length) {
      log(`WARNING: ${unverifiedGapJobs.length} coverage-gap checks got no verdict`)
      markNotRun('coverage-gaps-unverified', `${unverifiedGapJobs.length} coverage-gap check(s) got no verdict — the blind spots they name went unopened`)
    }
    const g = judge(gaps, gapVotes)
    log(`Coverage gaps: +${g.confirmed.length} confirmed · +${g.suspected.length} suspected · ${g.refuted.length} refuted`)
    return { found: found.concat(g.confirmed), doubtful: doubtful.concat(g.suspected), refutedGaps: g.refuted.length }
  }
  if (gaps.length) {
    log(`Budget too low to verify ${gaps.length} coverage gap(s) -> reported as suspected`)
    // Blocking, unlike `verify-checks-unjudged`, and the difference is epistemic rather than a matter
    // of degree. An unjudged *finding* is a claim that something is wrong; reporting it as Suspected
    // is already the honest answer, and the review still looked. A coverage gap is the critic's claim
    // that something went UNREVIEWED — the same category as a dead lens, which downgrades. Leaving it
    // advisory would let a plain `Approve` stand on a run whose named blind spots nobody opened.
    // It does not fire on routine runs: it needs the budget floor reached AND gaps raised.
    markNotRun('coverage-gaps-unverified', `${gaps.length} coverage gap(s) were never verified (budget floor reached) — they are reported as Suspected, and the blind spots they name went unopened`)
    return { found, doubtful: doubtful.concat(gaps.map(f => ({ ...f, confirmed: false, votes: [] }))), refutedGaps: 0 }
  }
  return { found, doubtful, refutedGaps: 0 }
}
const gapped = await withGapVerdicts(gaps, confirmed, suspected)
confirmed = gapped.found
suspected = gapped.doubtful
const refutedGaps = gapped.refutedGaps

// ---- Prior decisions: the project's recorded rejections, handed in by the launching session ----
// The same rules as review (the module carries them): a matching finding below critical/high whose
// decision's scope is unchanged since the recorded commit leaves the verdict and is returned under
// `rejectedBefore`, marked in its description; anything else is raised again with the decision named.
// >>> craft-inline lib/prior-decisions.mjs decisionScopeParts decisionText decisionFields decisionAnchorProblem decisionProblem readPriorDecision titleWords reraisedBySeverity PRIOR_DECISIONS_MAX DECISION_FIELD_MAX DECISION_TITLE_OVERLAP parsePriorDecisions decisionAnswers decisionsToCheck priorDecisionMark reraiseReason splitByDecisions scopeCheckScript SCOPE_CHECK_SCHEMA scopeCheckPrompt readScopeCheck applyPriorDecisions
/** Path segments with `.`, empty segments and separators folded; `..` kept literal. @param {string} p */
function decisionScopeParts(p) {
  return p.split(/[\\/]+/).filter(s => s && s !== '.')
}

/** @param {unknown} v @returns {string} */
function decisionText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The decision's fields as strings, trimmed. A memory record (skills/memory) is read as it is
 * recalled: `body`, `date` and `author` stand in for `reason`, `when` and `who`, and the first
 * http(s) URL in `links` for `link`.
 * @param {Record<string, unknown>} o @returns {PriorDecision}
 */
function decisionFields(o) {
  /** @param {string} k @param {string} [alt] */
  const f = (k, alt = '') => decisionText(o[k]) || decisionText(o[alt])
  const links = Array.isArray(o['links']) ? o['links'] : []
  const url = decisionText(links.find(l => /^https?:\/\//.test(decisionText(l))))
  return { id: f('id'), title: f('title'), scope: f('scope') || '.', reason: f('reason', 'body'), who: f('who', 'author'), when: f('when', 'date'), link: f('link') || url, commit: f('commit') }
}

/**
 * The scope and the commit go into a shell line (scopeCheckScript): a repo-relative path and a hash
 * only. '' when both are.
 * @param {PriorDecision} d @returns {string}
 */
function decisionAnchorProblem(d) {
  if (/^([\\/]|~|[A-Za-z]:)/.test(d.scope) || decisionScopeParts(d.scope).includes('..')) return `: scope ${JSON.stringify(d.scope)} is not a repo-relative path`
  if (d.commit && !/^[0-9a-f]{7,40}$/i.test(d.commit)) return `: commit ${JSON.stringify(d.commit)} is not a commit hash`
  return ''
}

/**
 * What is wrong with a decision, as the tail of a refusal sentence; '' when nothing is.
 * @param {Record<string, unknown>} o @param {PriorDecision} d @returns {string}
 */
function decisionProblem(o, d) {
  if (o['kind'] != null && decisionText(o['kind']) !== 'decision') return ` is a ${JSON.stringify(o['kind'])} record, not a decision`
  if (o['status'] != null && decisionText(o['status']) !== 'active') return ` is not active (status ${JSON.stringify(o['status'])})`
  if (!d.id || !d.title || !d.reason) return ' lacks an id, a title or a reason'
  const over = Object.entries(DECISION_FIELD_MAX).find(([k, max]) => d[/** @type {keyof PriorDecision} */ (k)].length > max)
  if (over) return `: ${over[0]} is ${d[/** @type {keyof PriorDecision} */ (over[0])].length} chars, over the ${over[1]}-char ceiling`
  return decisionAnchorProblem(d)
}

/**
 * One decision as given, checked: a refusal sentence, or the decision.
 * @param {unknown} raw @param {number} i @returns {PriorDecision | string}
 */
function readPriorDecision(raw, i) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `decision #${i} is not an object`
  const o = /** @type {Record<string, unknown>} */ (raw)
  const d = decisionFields(o)
  const problem = decisionProblem(o, d)
  return problem ? `decision #${i}${d.id ? ` (${d.id})` : ''}${problem}` : d
}

/** Lower-cased alphanumeric words of a title. @param {unknown} t */
function titleWords(t) {
  return new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
}

/** @param {unknown} sev */
function reraisedBySeverity(sev) {
  return /^(critical|high)$/i.test(String(sev ?? '').trim())
}

// The most decisions one run applies; the rest are refused by name and their findings raised normally.
const PRIOR_DECISIONS_MAX = 100

// Per-field ceilings. A field over its ceiling refuses the whole decision (said so) — a reason cut
// mid-sentence would mark a finding with a rationale nobody wrote.
const DECISION_FIELD_MAX = { id: 80, title: 200, scope: 300, reason: 1200, who: 120, when: 40, link: 500 }

// A decision answers a finding when the finding's file sits inside the decision's scope AND their
// titles share at least this share of words (of the longer one).
const DECISION_TITLE_OVERLAP = 0.6

/**
 * The `priorDecisions` argument, checked. Absent → nothing, silently: that is every run before this
 * existed. Anything else that is not a list of decisions → nothing applied, each problem named.
 * @param {unknown} raw
 * @returns {{ decisions: PriorDecision[], refused: string[] }}
 */
function parsePriorDecisions(raw) {
  if (raw == null || raw === '') return { decisions: [], refused: [] }
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return { decisions: [], refused: ['priorDecisions is a string that is not JSON — no decision applied'] } }
  }
  if (!Array.isArray(list)) return { decisions: [], refused: ['priorDecisions is not a list — no decision applied'] }
  /** @type {PriorDecision[]} */
  const decisions = []
  /** @type {string[]} */
  const refused = []
  list.slice(0, PRIOR_DECISIONS_MAX).forEach((item, i) => {
    const d = readPriorDecision(item, i)
    if (typeof d === 'string') refused.push(d)
    // The scope check answers by id: two decisions under one id could lend one's unchanged scope to
    // the other, so the second is refused.
    else if (decisions.some(x => x.id === d.id)) refused.push(`decision #${i} (${d.id}) repeats an id already given — not applied`)
    else decisions.push(d)
  })
  if (list.length > PRIOR_DECISIONS_MAX) {
    refused.push(`${list.length - PRIOR_DECISIONS_MAX} decision(s) past the cap of ${PRIOR_DECISIONS_MAX} were not applied — findings they would answer are raised normally`)
  }
  return { decisions, refused }
}

/**
 * Whether `d` answers finding `f`: the file inside the scope, and the titles overlapping enough.
 * @param {DecidableFinding} f @param {PriorDecision} d @returns {boolean}
 */
function decisionAnswers(f, d) {
  const file = decisionScopeParts(String(f.file ?? ''))
  const scope = decisionScopeParts(d.scope)
  if (!file.length || scope.length > file.length || scope.some((s, i) => s !== file[i])) return false
  const a = titleWords(f.title)
  const b = titleWords(d.title)
  if (!a.size || !b.size) return false
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(a.size, b.size) >= DECISION_TITLE_OVERLAP
}

/**
 * The decisions whose scope must be checked for change: those that answer some finding a decision
 * could set aside (not Critical/High) and that recorded a commit to compare against.
 * @param {DecidableFinding[]} findings @param {PriorDecision[]} decisions @returns {PriorDecision[]}
 */
function decisionsToCheck(findings, decisions) {
  const out = new Set(/** @type {PriorDecision[]} */ ([]))
  for (const f of findings) {
    if (reraisedBySeverity(f.severity)) continue
    const d = decisions.find(x => decisionAnswers(f, x))
    if (d && d.commit) out.add(d)
  }
  return [...out]
}

/** The mark a set-aside finding carries. @param {PriorDecision} d */
function priorDecisionMark(d) {
  return `REJECTED BEFORE: ${d.reason} — ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}, ${d.link || 'no link'} (decision ${d.id})`
}

/**
 * Why decision `d` cannot set finding `f` aside; '' when it can.
 * @param {DecidableFinding} f @param {PriorDecision} d @param {Set<string>} unchanged @returns {string}
 */
function reraiseReason(f, d, unchanged) {
  if (reraisedBySeverity(f.severity)) return 'a Critical/High finding is never set aside by a prior decision'
  if (!d.commit) return 'the decision records no commit, so an unchanged scope cannot be established'
  if (!unchanged.has(d.id)) return `the code in ${d.scope} changed since ${d.commit} (or that could not be checked)`
  return ''
}

/**
 * Split one tier's findings by the decisions. `unchanged` holds the ids of decisions whose scope was
 * observed unchanged since their commit; every other decision cannot set a finding aside. The mark
 * is appended to `noteField` — `why` in review, `description` in adversarial-review.
 * @template {DecidableFinding} F
 * @param {F[]} findings @param {PriorDecision[]} decisions @param {Set<string>} unchanged @param {string} tier @param {string} [noteField]
 * @returns {{ kept: F[], setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number }}
 */
function splitByDecisions(findings, decisions, unchanged, tier, noteField = 'why') {
  /** @type {F[]} */
  const kept = []
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  const setAside = []
  let reraised = 0
  for (const f of findings) {
    const d = decisions.find(x => decisionAnswers(f, x))
    if (!d) { kept.push(f); continue }
    const why = reraiseReason(f, d, unchanged)
    const note = `${String(f[noteField] ?? '')} · `
    if (!why) { setAside.push({ ...f, priorTier: String(f.tier || tier), priorDecision: d.id, [noteField]: note + priorDecisionMark(d) }); continue }
    reraised++
    kept.push({ ...f, [noteField]: `${note}Rejected before (decision ${d.id}, ${d.who || 'author not recorded'}, ${d.when || 'date not recorded'}) — raised again: ${why}.` })
  }
  return { kept, setAside, reraised }
}

/**
 * The shell lines the scope check runs: one `git diff --quiet` per decision, printing its id and the
 * exit status (0 = unchanged since the commit, working tree included). Arguments single-quoted.
 * @param {PriorDecision[]} decisions @returns {string}
 */
function scopeCheckScript(decisions) {
  /** @param {string} s */
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  return decisions.map(d => `git diff --quiet ${q(d.commit)} -- ${q(d.scope)}; echo ${q(d.id)} $?`).join('\n')
}

// What the scope-check agent returns: the ids it saw print status 0.
const SCOPE_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unchanged', 'reason'],
  properties: {
    unchanged: { type: 'array', items: { type: 'string' }, description: 'ids whose line ended in exit status 0, exactly as printed' },
    reason: { type: 'string', description: 'one line: anything that did not run' },
  },
}

/** The scope-check agent's prompt. @param {PriorDecision[]} decisions @returns {string} */
function scopeCheckPrompt(decisions) {
  return `Run these lines in the repository under review, exactly as written (shell only, read only). Each prints a decision id and the exit status of \`git diff --quiet\` against that decision's commit.
${scopeCheckScript(decisions)}
Return {unchanged: [every id whose printed status was 0], reason: one line on anything that did not run}.`
}

/**
 * The ids a scope-check answer names unchanged, or null when the answer is missing or unreadable —
 * then no decision is shown unchanged and nothing is set aside.
 * @param {unknown} ans @returns {string[] | null}
 */
function readScopeCheck(ans) {
  const u = ans && typeof ans === 'object' ? /** @type {Record<string, unknown>} */ (ans)['unchanged'] : null
  return Array.isArray(u) ? u.filter(x => typeof x === 'string') : null
}

/**
 * Applies the decisions to every tier of an engine's findings. `checkScopes` runs the scope check for
 * the decisions it is handed (never called with none) and returns the agent's raw answer.
 * @template {DecidableFinding} F
 * @param {Record<string, F[]>} tiers @param {PriorDecision[]} decisions
 * @param {(toCheck: PriorDecision[]) => Promise<unknown>} checkScopes @param {string} [noteField]
 * @returns {Promise<{ tiers: Record<string, F[]>, setAside: Array<F & { priorTier: string, priorDecision: string }>, reraised: number, notes: string[] }>}
 */
async function applyPriorDecisions(tiers, decisions, checkScopes, noteField = 'why') {
  /** @type {Array<F & { priorTier: string, priorDecision: string }>} */
  let setAside = []
  /** @type {string[]} */
  const notes = []
  if (!decisions.length) return { tiers, setAside, reraised: 0, notes }
  const toCheck = decisionsToCheck(Object.values(tiers).flat(), decisions)
  const unchanged = new Set(/** @type {string[]} */ ([]))
  if (toCheck.length) {
    const ids = readScopeCheck(await checkScopes(toCheck))
    if (ids == null) notes.push(`the scope-check agent died or answered unreadably — no decision could be shown unchanged, so the ${toCheck.length} decision(s) set nothing aside`)
    // An id outside `toCheck` sets nothing aside: splitByDecisions only consults decisions that answer
    // a finding below Critical/High and carry a commit, which is exactly what was checked.
    for (const id of ids || []) unchanged.add(id)
  }
  let reraised = 0
  /** @type {Record<string, F[]>} */
  const out = {}
  for (const [tier, list] of Object.entries(tiers)) {
    const r = splitByDecisions(list, decisions, unchanged, tier, noteField)
    out[tier] = r.kept
    setAside = setAside.concat(r.setAside)
    reraised += r.reraised
  }
  notes.push(`${decisions.length} decision(s) given, ${setAside.length} finding(s) set aside as rejected before, ${reraised} raised again`)
  return { tiers: out, setAside, reraised, notes }
}
// <<< craft-inline
const priorDecisionsIn = parsePriorDecisions(A['priorDecisions'])
for (const r of priorDecisionsIn.refused) log(`WARNING: priorDecisions: ${r}`)
const prior = await applyPriorDecisions(
  /** @type {Record<string, Array<(typeof confirmed)[number] | (typeof suspected)[number]>>} */ ({ confirmed, suspected }),
  priorDecisionsIn.decisions,
  toCheck => agent(scopeCheckPrompt(toCheck), { label: 'decision-scope', phase: 'Coverage', schema: SCOPE_CHECK_SCHEMA, effort: 'low' }),
  'description',
)
for (const n of prior.notes) log(`priorDecisions: ${n}`)
confirmed = /** @type {typeof confirmed} */ (prior.tiers['confirmed'])
suspected = /** @type {typeof suspected} */ (prior.tiers['suspected'])
/** What the returned object adds for prior decisions — nothing at all when none were given. */
function priorDecisionsResult() {
  return {
    ...(prior.setAside.length ? { rejectedBefore: prior.setAside.map(({ votes: _v, ...f }) => f) } : {}),
    ...(priorDecisionsIn.refused.length ? { priorDecisionsNotApplied: priorDecisionsIn.refused } : {}),
  }
}

// A verdict must never claim more coverage than the run had: a dimension that went unreviewed
// downgrades the verdict, so a run where the work died cannot read exactly like a clean one. The
// advisory entries (see `markNotRun`) are recorded and printed but do NOT downgrade — their
// findings are already reported as Suspected, and a marker that fires on routine runs stops being
// read on the runs that need it.
/** @param {{ severity: string }[]} found @returns {string} */
function verdictOf(found) {
  const baseVerdict = found.some(f => f.severity === 'critical' || f.severity === 'high') ? 'Block'
    : found.some(f => f.severity === 'medium') ? 'Warning' : 'Approve'
  return notRunBlocking().length ? `${baseVerdict} (INCOMPLETE)` : baseVerdict
}
const verdict = verdictOf(confirmed)
log(`Verdict: ${verdict} — ${confirmed.length} confirmed, ${suspected.length} suspected`)
for (const e of notRun) log(`${e.incomplete ? 'NOT RUN' : 'PARTIAL'}: ${e.note}`)

// ---- run record ----
const candidates = kept.length + gaps.length
const refutedTotal = refuted.length + refutedGaps
await logRun({
  ...recordHead(),
  verdict,
  findings: summarizeFindings([...confirmed, ...suspected].map(capSeverity)),
  scout: scoutRecord(plan.lenses),
  dimensions: plan.lenses.map((/** @type {string} */ l) => {
    const s = summarizeFindings(confirmed.filter(f => (f.sources || []).includes(l)).map(capSeverity))
    return { dimension: l, verdict: '', findingCount: s.total, bySeverity: s.bySeverity }
  }),
  verification: { candidates, confirmed: confirmed.length, refuteRate: refuteRate(refutedTotal, candidates) },
  notRun: notRunLabels(),
  outputTokens: budget.spent(),
})

return {
  verdict,
  confirmed: confirmed.map(({ votes: v, ...f }) => ({ ...f, votes: v.length, refutes: v.filter(x => x.refuted).length })),
  suspected: suspected.map(({ votes: v, ...f }) => f),
  notRun: notRunNotes().concat(telemetryNotes()),
  scout: { size: plan.sizeBucket, lenses: plan.lenses, deadLenses },
  // Only when given: an invocation without priorDecisions returns exactly what it always did.
  ...priorDecisionsResult(),
}
