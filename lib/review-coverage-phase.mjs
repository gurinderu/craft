// Which language profiles review the diff (src/review.js, Scout phase): the pin, the coverage decision and its
// early exits, the memory recall for the diff's paths, and the changed files no profile covers.
import { parsePriorDecisions } from './prior-decisions.mjs'
import { MEMORY_RECALL_SCHEMA, memoryRecord, skippedMemory, mergeRecall, recallDecisions } from './memory-recall.mjs'
import { resolveProfilePin, unknownPinMessage, noLanguageMessage, noChangedFilesMessage, baseIsHead, onTrunkMessage, coverageGapFiles, resolveCoverage, nothingToReviewMessage } from './review-coverage.mjs'
import { summarizeFindings } from './run-record.mjs'
import { PROFILES } from './review-profiles.mjs'

/**
 * @typedef {import('./review-schemas.mjs').DetectAnswer} DetectAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */

/**
 * The active profiles and the uncovered files, or the report of the exit that stopped the run.
 * @param {ReviewRun} reviewRun
 * @param {{ detected: DetectAnswer, baseRef: string, changedFiles: string[], branch: string, head: string, routeNoProfile?: boolean }} change  what detect
 *   resolved; `routeNoProfile`: a diff no profile covers goes wholly to the nested adversarial review (lib/review-nested.mjs)
 */
export async function coveragePhase(reviewRun, { detected, baseRef, changedFiles, branch, head, routeNoProfile = false }) {
const { craftVersion, A, baseArg, scopeNotRun, scopeSection, viaArg, recalledByLauncher, requestedLangs, ragent, logRun, out, extraLensesNotRun, depthRecordFields } = reviewRun
const { log: logLine, budget: tokenBudget } = reviewRun.sb
// Active profiles: detected in the diff, intersected with any explicit pin. If a pin names a profile
// the detector missed (best-effort detection), honor the pin. An unknown pin id is an ERROR (it used
// to be dropped by `filter(Boolean)`), and a diff no profile covers is INCOMPLETE, never an Approve.
const { pinned: pinnedLangs, unknown: unknownLangs } = resolveProfilePin(PROFILES, requestedLangs)
async function unknownPinExit() {
  const msg = unknownPinMessage(PROFILES, unknownLangs)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'INCOMPLETE (unknown language pin)', findings: summarizeFindings([]), dimensions: [], verification: null,
    notRun: [`nothing ran — ${msg}`, ...scopeNotRun, ...extraLensesNotRun('the language pin is unknown')], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
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
reviewRun.active = active
// The coverage decision's early exits: an empty diff, nothing reviewable, or no profile for what changed.
async function coverageExit() {
  if (coverage.outcome === 'no-profile' && routeNoProfile) return null
  if (coverage.outcome === 'no-profile') reviewRun.memory = skippedMemory(reviewRun.memory, 'no language profile for the changed files')
  else if (coverage.outcome !== 'review') reviewRun.memory = skippedMemory(reviewRun.memory, 'nothing to review')
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
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    // The base this run resolved, so a later reader of the store can see what the empty diff was taken against.
    base: baseRef || '',
    languages: [], verdict: 'INCOMPLETE (empty diff)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: [], notRun: [emptyMsg, ...scopeNotRun, ...extraLensesNotRun('the diff is empty', false)], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
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
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'Approve (nothing to review)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [...scopeNotRun, ...extraLensesNotRun('nothing reviewable changed', false)], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
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
    schemaVersion: 1, runtime: 'claude-code', craftVersion: craftVersion, kind: 'workflow', name: 'review', nested: !!viaArg, via: viaArg || null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict: 'INCOMPLETE (no language profile)', findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles, notRun: [msg, ...scopeNotRun, ...extraLensesNotRun('no language profile covers the diff')], ...depthRecordFields(), outputTokens: tokenBudget.spent(),
  })
  return out([
    `## Verdict`, `⚠️ INCOMPLETE — ${msg}`,
    ``, `## Detected`, detected?.notes || `${changedFiles.length} changed file(s)`,
    ...(changedFiles.length ? [``, `## Not reviewed (no language profile)`, ...changedFiles.map((/** @type {string} */ f) => `- ${f}`)] : []),
  ].join('\n') + scopeSection())
}
// An unknown language pin first: it stops the run before any profile is activated.
const languageStop = unknownLangs.length ? await unknownPinExit() : await coverageExit()
if (languageStop !== null) return { exit: languageStop }
// No profile and the nested run allowed: the whole diff goes to it (realm @nick/craft, node #420), which recalls its own.
if (coverage.outcome === 'no-profile') {
  reviewRun.memory = skippedMemory(reviewRun.memory, 'no language profile for the changed files')
  return { exit: null, active, uncoveredFiles: changedFiles, uncoveredGap: coverage.material, routeAll: true }
}
// ONE read-only agent recalls the decisions through the craft:memory skill for the diff's paths (realm
// @nick/craft, node #203); its answer is parsed like a passed list and the passed records merge into it.
// After the coverage exits: a diff with nothing to review or no profile spends no recall agent.
async function recallMemory() {
  if (recalledByLauncher || !changedFiles.length) return
  const r = await recallDecisions(p => ragent(p, { label: 'memory-recall', phase: 'Scout', schema: MEMORY_RECALL_SCHEMA, effort: 'low' }), changedFiles, baseRef || '')
  const m = mergeRecall(r, A['priorDecisions'], parsePriorDecisions)
  reviewRun.priorDecisionsIn = m.prior
  reviewRun.memory = m.memory
  for (const x of m.recalledRefused) logLine(`⚠️ priorDecisions: ${x}`)
}
await recallMemory()
function logActiveProfiles() {
  logLine(`Active profiles: ${active.map(p => p.id).join(', ')}${pinnedLangs ? ` (pinned: ${pinnedLangs.join(',')})` : ''} · base ${baseRef || 'HEAD'}`)
}
logActiveProfiles()

// Changed files no active profile covers are NOT reviewed — say so instead of silently shrinking scope.
// The ones that are a real coverage gap (see coverageGapFiles: material AND not project config)
// additionally reach the verdict further down, so it carries the (INCOMPLETE) marker rather than a
// bare Approve.
const uncoveredFiles = changedFiles.filter((/** @type {string} */ f) => !active.some(p => p.detect([f])))
const uncoveredGap = coverageGapFiles(uncoveredFiles)
function logUncoveredFiles() {
  if (uncoveredFiles.length) logLine(`Outside all active profiles (not reviewed): ${uncoveredFiles.join(', ')}${uncoveredGap.length ? ` — ${uncoveredGap.length} unreviewed source file(s)` : ' (docs/assets/lockfiles/project config only — not a coverage gap)'}`)
}
logUncoveredFiles()
return { exit: null, active, uncoveredFiles, uncoveredGap, routeAll: false }
}
