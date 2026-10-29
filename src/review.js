import { openReviewRun } from '../lib/review-run.mjs'
import { detectPhase } from '../lib/review-detect.mjs'
import { priorRoundPhase } from '../lib/review-prior-round.mjs'
import { priorBasisPhase } from '../lib/review-prior-basis.mjs'
import { coveragePhase } from '../lib/review-coverage-phase.mjs'
import { makeLensPrompts } from '../lib/review-lens-prompts.mjs'
import { makeExtraLenses } from '../lib/review-extra-lens-run.mjs'
import { makeDedup } from '../lib/review-dedup.mjs'
import { makeVerifyPool } from '../lib/review-verify-pool.mjs'
import { makePlanner } from '../lib/review-plan.mjs'
import { makeGate } from '../lib/review-gate.mjs'
import { reviewProfile } from '../lib/review-profile.mjs'
import { makeRunRecord } from '../lib/review-record.mjs'
import { adjudicatePhase } from '../lib/review-adjudicate-priors.mjs'
import { reconcilePhase } from '../lib/review-reconcile-priors.mjs'
import { setAsidePhase } from '../lib/review-set-aside.mjs'
import { synthesisPhase } from '../lib/review-synthesis.mjs'
import { sortingPhase } from '../lib/review-sorting.mjs'
import { ledgerPhase } from '../lib/review-ledger.mjs'
import { finalReport } from '../lib/review-final-report.mjs'

export const meta = {
  name: 'review',
  description: 'Elastic deep review of a diff — auto-detects the language(s) touched, scout-scaled lens fan-out, loop-until-dry, tool-grounded seed findings, adversarial + self-verification, synthesized into one Confirmed/Suspected/Unverified report with a verdict. Rust and Nix profiles built in.',
  whenToUse: 'The single review path for any diff/PR before commit or merge. The engine itself always recalls the active decisions, questions and project rules for the paths of the diff through the craft:memory skill; priorDecisions is optional and ADDS to that recall, never replaces it (merged by id, the recalled record kept on a clash; an empty list adds nothing; a passed record may leave out id when it carries kind, title and scope, the id then derived from them by the memory skill rule), and the report names both parts. To post findings on a PR pass comment — never post findings by hand: only comments from the engine carry the marker that ties a later rejection to its finding. With comment only defects are posted: a doubtful finding (not confirmed, raised by the compat, intent or api-boundary lens, about rollback, rollout, old replicas, migration or a breaking change, or outside the changed lines) is listed under Doubtful — for the reviewer, not posted, numbered as the run record keeps it; show that list to the human and, for each he chooses, post it as a question or a defect only through the craft:addressing-findings posting script. Auto-detects language; pin with args.languages (e.g. ["rust"] or ["nix"]). Scales depth to the diff automatically. To review ANOTHER repository pass repo=<absolute path> — without it every git command runs in the checkout the session itself sits in; path= is a repo-relative pathspec, NOT a way to select the repo. The performance / api-idioms / api-boundary lenses are an OPTIONAL pass that is OFF by default — request it with optional=true (or optional=performance,api-boundary); every report names what it skipped. priorDecisions — ONLY inside an object argument, {priorDecisions: [<decision, question and rule records the launcher holds beyond what the engine recalls, such as rejections read from PR threads>]}; as a string (key=value or JSON text) it is refused and nothing of it applied, and in a key=value string nothing after it is read as an option — sets aside a finding the project already rejected — listed under Rejected before with who, when, why and a link, never dropped — unless it is Critical/High or its scope changed since the commit of the decision; a finding an active question (a deferred finding) answers is listed under Known and deferred by the same rules; a finding a judge puts under an active project rule (a stance on a whole class of findings) is listed under Covered by project rules, out of the verdict and never posted, unless it is Critical; a malformed value applies nothing and is named in the report. depth=light is a cheaper pass: one round of the diff-scoped lenses only (no negative-space or invariants; tests and intent still run whenever the diff changes production code, reconciler and failure-windows on controller code, compat on a public contract path), no completeness critic, and only Medium and above verified; its verdict and report say light pass and name what it skipped, and the run record carries depth (default depth=full, the review as it was). The engine accepts only depth=light (any other value runs full): routing a "quick" or "light" request to it belongs to the calling skill or hook. The consumer repository\'s own reviewing agents can run as extra lenses in the same run: each reviews the whole change and its findings go through the same verification and verdict. On a light pass with extraLenses absent, the engine discovers them among the .claude/agents of the project the session runs in, and only when repo= is absent or names that project or one of its worktrees (a foreign repo skips discovery and the report says so) (an agent that reviews and has no edit tool -- its tools list names none, or its disallowedTools take them all away -- told to stay read-only; the report says when none was found); a full review runs them only when named. extraLenses=[<agentType>, ...] (an object argument, e.g. {extraLenses: ["reviewer"]}) names them at either depth, and extraLenses=[] turns them off; a named agent that is unknown or fails is a coverage gap (INCOMPLETE), never a failed run; a discovered one that cannot run is reported as such, never a gap. The report names which extra lenses ran and how they were chosen. unitScope=true is an experimental mode, off by default, over the units a language profile finds in the diff and links into a dependency graph (Rust: its Cargo crates; on a profile with no units, a change that touches none, or one too small to slice by unit — fewer than 12 files, or one unit with unitBatches=false — the review runs in the normal mode, no contract lens, seam pass or coordinator, and the report says why in one warning line, never a failure; a unit probe that died or answered off-schema runs the normal mode too, its warning says the probe failed — a warning only, the lenses ran fully, so no coverage hole): each code-intrinsic lens is confined to one unit and asks a live coordinator about the others, a seam pass checks the cross-unit integration and a contract lens judges each touched unit\'s public contract; the lenses run over unit batches chosen by cost estimate: candidate partitions (one agent per unit, and the dependency-connected components split along their edges at several volume budgets, small unconnected units packed together by volume within the budget — never a whole component or every unit in one batch regardless of volume, since the budget is what keeps a batch focused) are each estimated by a per-lens cost model fitted on past runs, and the cheapest whose heaviest agent is at or under the estimate of the heaviest sliced lens agent a normal review would send over one of its slices (the whole change when normal review does not slice it) is taken (none fits: the one with the lightest heaviest agent); unitBatchBudget=<lines> pins the partition to one volume budget, unitAgentCeiling=<tokens> replaces the ceiling, costModel={agentFixed, unit: {perChangedLine, perFile, perCodeLine, perSigLine}, lenses: {<lens>: {fixed, rate}}, pooled: {fixed, rate}} overrides any coefficient; every code-intrinsic lens one agent of its own per batch, as normal review gives each lens its own agent per slice (unitBatches=false gives one agent per unit and lens instead); the run record carries unitScope, the batches, every candidate with its estimate, the ceiling and the reason for the choice, and after the run `node "<craft plugin root>/lib/unit-boundary.mjs" ~/.claude/projects/<project slug>/<session id>/subagents/workflows/wf_<run id>` (the plugin root is two directories above a craft skill\'s base directory; the run directory holds the agent-*.jsonl transcripts) lists what the confined lenses and the contract lens read outside their unit. deadlineMs=<ms> is a diagnostic knob, not a review option: it replaces the per-phase wall-clock deadline table wholesale and will kill healthy lenses if set below their real duration.',
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
 */

// The craft release that produced a run. Recorded on every run record and index line so an
// aggregate can be filtered to ONE engine version: without it, "did tightening that lens help?"
// is unanswerable, because the numbers blend runs from every rubric the store has ever seen.
// MUST match `.claude-plugin/plugin.json` — `lib/check-workflows.mjs` fails the build if it drifts.
// Pair it with craftCommit (the engine's git HEAD, added by the logger): the version identifies a
// release, the commit separates two runs of the same release while the rubric is being edited.
const CRAFT_VERSION = '0.35.1' // x-release-please-version
// The per-profile results, filled as the profiles run; the report wrapper reads them on every exit.
/** @type {Result[]} */
const results = []
// The run: its options read from `args`, its one dispatch path, its telemetry and the wrapper every report goes
// out through (lib/review-run.mjs). The sandbox globals are handed in; lib/ code never names them free.
const reviewRun = openReviewRun({ args, agent, parallel, phase, log, budget }, CRAFT_VERSION, results)

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

const { gateFailed, mergedProvenance, mergedGateStatus, carriedSection, carriedLine, reviewRecord, gateFailedExit } = makeRunRecord(reviewRun, { results, branch, head, active, uncoveredFiles, reReview, priorBasisVerdict, priorBasisMismatch, basisOverridesLogger, priorFpComparable, tombstonesDroppedForBasis: () => tombstonesDroppedForBasis, priorLedgerDegraded, priorRoundJournalSourced, priorRound, fullRescan, baseRef, spec, changedFiles, thisRound })
if (gateFailed.length) return await gateFailedExit()

let confirmed = results.flatMap(r => r['confirmed'])
let suspected = results.flatMap(r => r['suspected'])
// Low/Info nothing looked at. A third track, not a corner of Suspected — see verifyPool.
let unverified = results.flatMap(r => r['unverified'] || [])

// The re-review tracks (lib/review-adjudicate-priors.mjs, lib/review-reconcile-priors.mjs), then what leaves the verdict before synthesis.
const adjudication = await adjudicatePhase(reviewRun, { tierLists: { confirmed, suspected, unverified }, priorRound, results, active })
unverified = adjudication.unverified
const { adjudicated, priorTombstones, carriedDeferred } = adjudication

;({ confirmed, suspected, unverified, tombstonesDroppedForBasis } = reconcilePhase(reviewRun, { tierLists: { confirmed, suspected, unverified }, priorBasisMismatch, priorRound, priorTombstones, priorBasisVerdict, adjudicated, priorFpComparable }))

const setAside = await setAsidePhase(reviewRun, { tierLists: { confirmed, suspected, unverified }, results, uncoveredGap, adjudicated, priorTombstones, reviewRecord, thisRound, mergedGateStatus, active, mergedProvenance, carriedSection, uncoveredFiles })
if (setAside.exit !== null) return setAside.exit
;({ confirmed, suspected, unverified } = setAside)
const { priorRejected, priorRejectedLive, priorDisposition, ruleNotices, dropped, thinned, notRun, savedByFloor, coverageNotes, incompleteNotes, criticNotes } = setAside

const { report, isRereview, synthesisUnusable } = await synthesisPhase(reviewRun, { priorRound, adjudicated, tierLists: { confirmed, suspected, unverified }, notRun, incompleteNotes, active, thisRound, mergedProvenance, carriedLine, uncoveredFiles, criticNotes })

const { sortingRecord, contradictionsRecord, doubtfulReport } = await sortingPhase(reviewRun, { tierLists: { confirmed, suspected, unverified }, baseRef })

const { recordVerdict, floorPremiseHeld } = await ledgerPhase(reviewRun, { tierLists: { confirmed, suspected, unverified }, dropped, priorRejected, priorRejectedLive, isRereview, adjudicated, savedByFloor, notRun, thisRound, priorFpComparable, priorTombstones, priorDisposition, branch, head, reviewRecord, coverageNotes, results, thinned, sortingRecord, contradictionsRecord })

return finalReport(reviewRun, { isRereview, recordVerdict, tierLists: { confirmed, suspected, unverified }, mergedProvenance, carriedSection, uncoveredFiles, synthesisUnusable, notRun, coverageNotes, adjudicated, floorPremiseHeld, savedByFloor, report, priorRejected, carriedDeferred, ruleNotices, doubtfulReport })
}