// The merged run (src/review.js, after every profile ran): the gate across profiles, the pre-existing red checks
// every verdict prints, the review's run record and the exit a red gate takes.
import { memoryRecord } from './memory-recall.mjs'
import { failedProfiles, gateRecord, surfaceGateRecord } from './profile-merge.mjs'
import { summarizeFindings } from './run-record.mjs'
import { agentUnavailableRecord } from './agent-fallback.mjs'
import { roundYield, lensRoundYield, unattributedCount } from './lens-round-yield.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-profile.mjs').ProfileReview} Result
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The merged gate and the record builder of one run.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'results' | 'branch' | 'head' | 'active' | 'uncoveredFiles' | 'reReview' | 'priorBasisVerdict' | 'priorBasisMismatch' | 'basisOverridesLogger' | 'priorFpComparable' | 'tombstonesDroppedForBasis' | 'priorLedgerDegraded' | 'priorRoundJournalSourced' | 'priorRound' | 'fullRescan' | 'baseRef' | 'spec' | 'changedFiles' | 'thisRound'>} state
 */
export function makeRunRecord(reviewRun, { results, branch, head, active, uncoveredFiles, reReview, priorBasisVerdict, priorBasisMismatch, basisOverridesLogger, priorFpComparable, tombstonesDroppedForBasis, priorLedgerDegraded, priorRoundJournalSourced, priorRound, fullRescan, baseRef, spec, changedFiles, thisRound }) {
const { craftVersion, intentArg, pathArg, scopeNotRun, scopeSection, viaArg, strict, fullEvery, optionalRequested, optionalNamedByCritic, optionalTally, surfaceGateDispatched, surfaceGateNamedByCritic, logRun, reviewerAgentUnavailable, reviewerAgentFallbacks, reviewerAgentNames, out, extraLensesNotRun, depthRecordFields } = reviewRun
const { budget: tokenBudget } = reviewRun.sb
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
    craftVersion: craftVersion,
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
    reReview: { chained: reReview.chained, reason: reReview.reason, basisVerdict: priorBasisVerdict, basisMismatch: priorBasisMismatch, basisOverridesLogger, fpComparable: priorFpComparable, tombstonesDropped: tombstonesDroppedForBasis(), ledgerDegraded: priorLedgerDegraded, journalSourced: priorRoundJournalSourced, priorRound: priorRound?.['round'] ?? null, priorHead: priorRound?.['head'] ?? null },
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
    outputTokens: tokenBudget.spent(),
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
return { gateFailed, mergedProvenance, mergedGateStatus, carriedSection, carriedLine, reviewRecord, gateFailedExit }
}
