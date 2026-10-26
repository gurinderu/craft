import { reraisedBySeverity } from '../lib/prior-decisions.mjs'
import { memoryRecord } from '../lib/memory-recall.mjs'
import { toolDistinct, toolIdentity, MATCH_JUDGE_SCHEMA } from '../lib/prior-decision-match.mjs'
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
import { failedProfiles, gateRecord, surfaceGateRecord } from '../lib/profile-merge.mjs'
import { supportedLangLabel, uncoveredNotRunNote, verdictSuffix, canonicalSeverity } from '../lib/review-coverage.mjs'
import { PATH_FLOOR_MARK } from '../lib/path-severity-floor.mjs'
import { sanitizeAttack, baseWhy, isHighSeverity, classifyRedTeam, adjudicateOne, shouldRedTeam, withoutAbsorbed, absorbedPromptBlock, absorbAcross, markTrackedUnverified, redTeamInvariant } from '../lib/review-adjudicate.mjs'
import { honestVerdict, honestVerdictLine } from '../lib/honest-verdict.mjs'
import { summarizeFindings, refuteRate, fingerprint, matchesPrior, rereviewVerdict } from '../lib/run-record.mjs'
import { agentUnavailableRecord } from '../lib/agent-fallback.mjs'
import { shq } from '../lib/run-logging.mjs'
import { LEDGER_SHARD_PHASE, shardLedger, tombstoneRound, pruneTombstones, tombstoneBudget } from '../lib/ledger-shards.mjs'
import { ledgerRecordFields } from '../lib/ledger-in-shards.mjs'
import { roundYield, lensRoundYield, unattributedCount } from '../lib/lens-round-yield.mjs'
import { CHANGED_SCHEMA, PR_COMMENTS_SCHEMA, ADJUDICATE_SCHEMA, ATTACK_SCHEMA } from '../lib/review-schemas.mjs'
import { flattenField, promptFields } from '../lib/prompt-fields.mjs'
import { PROFILES } from '../lib/review-profiles.mjs'
import { toLedgerEntry } from '../lib/review-ledger-entry.mjs'
import { openReviewRun } from '../lib/review-run.mjs'
import { detectPhase } from '../lib/review-detect.mjs'
import { priorRoundPhase } from '../lib/review-prior-round.mjs'
import { priorBasisPhase } from '../lib/review-prior-basis.mjs'
import { coveragePhase } from '../lib/review-coverage-phase.mjs'
import { makeLensPrompts } from '../lib/review-lens-prompts.mjs'
import { makeExtraLenses } from '../lib/review-extra-lens-run.mjs'
import { makeDedup } from '../lib/review-dedup.mjs'
import { makeVerifyPool, CULL_MODEL } from '../lib/review-verify-pool.mjs'
import { makePlanner } from '../lib/review-plan.mjs'
import { makeGate } from '../lib/review-gate.mjs'
import { reviewProfile } from '../lib/review-profile.mjs'

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
 * @typedef {import('../lib/review-profile.mjs').ProfileReview} Result  one profile's facts from reviewProfile
 * @typedef {PriorRoundAnswer} PriorRound  the loaded prior round (loader agent output)
 * @typedef {import('../lib/review-schemas.mjs').Finding} Finding
 * @typedef {import('../lib/review-profiles.mjs').Profile} Profile
 */
/**
 * @template T
 */
/**
 * The answers of the schema'd agents (lib/review-schemas.mjs).
 * @typedef {import('../lib/review-schemas.mjs').LedgerAnswer} LedgerAnswer
 * @typedef {import('../lib/review-schemas.mjs').PriorRoundAnswer} PriorRoundAnswer
 * @typedef {import('../lib/review-schemas.mjs').AdjudicateAnswer} AdjudicateAnswer
 */

// The craft release that produced a run. Recorded on every run record and index line so an
// aggregate can be filtered to ONE engine version: without it, "did tightening that lens help?"
// is unanswerable, because the numbers blend runs from every rubric the store has ever seen.
// MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs` fails the build if it drifts.
// Pair it with craftCommit (the engine's git HEAD, added by the logger): the version identifies a
// release, the commit separates two runs of the same release while the rubric is being edited.
const CRAFT_VERSION = '0.34.1' // x-release-please-version
// The per-profile results, filled as the profiles run; the report wrapper reads them on every exit.
/** @type {Result[]} */
const results = []
// The run: its options read from `args`, its one dispatch path, its telemetry and the wrapper every report goes
// out through (lib/review-run.mjs). The sandbox globals are handed in; lib/ code never names them free.
const reviewRun = openReviewRun({ args, agent, parallel, phase, log, budget }, CRAFT_VERSION, results)
const { SEV_RANK, isMaintainability, finalVerdict, intentArg, postComments, pathArg, scopeNotRun, scopeSection, viaArg, strict, fullEvery, optionalRequested, optionalNamedByCritic, optionalTally, surfaceGateDispatched, surfaceGateNamedByCritic, REPO_DIRECTIVE, limitStop, ragent, checkpoint, logRun, reviewerAgentUnavailable, reviewerAgentFallbacks, reviewerAgentNames, out, extraLensesNotRun, depthRecordFields } = reviewRun


const detection = await detectPhase(reviewRun)
if (detection.exit !== null) return detection.exit
const { detected, baseRef, changedFiles, spec, branch, head } = detection


const { priorRound, reReview } = await priorRoundPhase(reviewRun, { baseRef, branch })


const { thisRound, priorBasisMismatch, basisOverridesLogger, priorFpComparable, priorBasisVerdict, priorLedgerDegraded, priorRoundJournalSourced, fullRescan, lensBase } = priorBasisPhase(reviewRun, { priorRound, baseRef })

let tombstonesDroppedForBasis = 0

const coverage = await coveragePhase(reviewRun, { detected, baseRef, changedFiles, branch, head })
if (coverage.exit !== null) return coverage.exit
const { active, uncoveredFiles, uncoveredGap } = coverage


// The per-profile toolkit: the prompts, the extra lenses, the dedup, the verification pool, the planner and the
// gate (lib/), each built once for the run.
const prompts = makeLensPrompts(reviewRun, { lensBase, priorRound, fullRescan })
const extras = makeExtraLenses(reviewRun, { active, extraLensPrompt: prompts.extraLensPrompt })
const dedup = makeDedup(reviewRun)
const verifier = makeVerifyPool(reviewRun)
const planner = makePlanner(reviewRun, { spec, changedFiles })
const gate = makeGate(reviewRun, { baseRef })











// ================= Run each active profile, then merge =================
async function reviewActiveProfiles() {
  for (const p of active) results.push(await reviewProfile(reviewRun, p, { prompts, extras, dedup, verifier, planner, gate, branch, head, baseRef, thisRound, changedFiles }))
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
    memory: memoryRecord(reviewRun.memory),
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
  if (!deferralReleased(deferral, reviewRun.priorDecisionsIn.decisions)) return true
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
    reviewRun.reReviewMemoryNote = reviewRun.reReviewMemoryNote ? `${reviewRun.reReviewMemoryNote}\n${note}` : note
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
    reviewRun.reReviewMemoryNote = reviewRun.reReviewMemoryNote ? `${reviewRun.reReviewMemoryNote}\n${note}` : note
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
  const r = await applyPriorDecisions({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, reviewRun.priorDecisionsIn.decisions, toCheck => ragent(
    REPO_DIRECTIVE + scopeCheckPrompt(toCheck),
    { label: 'decision-scope', phase: 'Synthesize', schema: SCOPE_CHECK_SCHEMA, model: CULL_MODEL },
  ), 'why', prompt => ragent(prompt, { label: 'decision-match', phase: 'Synthesize', schema: MATCH_JUDGE_SCHEMA, model: CULL_MODEL, effort: 'low' }))
  takeTiers(r.tiers)
  priorRejectedLive = live - adjudicated.stillOpen.length - adjudicated.regressed.length
  // A prior's ledger tier is its own; one that carries none is persisted as confirmed (it was adjudicated).
  priorRejected = r.setAside.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' })
  for (const n of r.notes) log(`priorDecisions: ${n}`)
  // A decision whose commit this repo does not know is named with the refusals, apart from a changed scope.
  reviewRun.priorDecisionsIn.refused.push(...r.refused)
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
  const r = await applyProjectRules({ confirmed, suspected, unverified, stillOpen: adjudicated.stillOpen, regressed: adjudicated.regressed }, reviewRun.priorDecisionsIn.decisions, 'why', prompt => ragent(prompt, { label: 'rule-match', phase: 'Synthesize', schema: RULE_JUDGE_SCHEMA, model: CULL_MODEL, effort: 'low' }))
  if (!r.rules) return
  takeTiers(r.tiers)
  priorRejectedLive += live - adjudicated.stillOpen.length - adjudicated.regressed.length
  priorRejected = priorRejected.concat(r.covered.map(f => /^(confirmed|suspected|unverified)$/.test(f.priorTier) ? f : { ...f, priorTier: 'confirmed' }))
  ruleNotices = r.notices
  reviewRun.memory = { ...reviewRun.memory, covered: r.covered.length }
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
  return ledgerRecordFields(reviewLedger, shards, landed && !reviewRun.rejoinArmed)
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