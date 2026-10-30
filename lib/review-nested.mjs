// The source files outside every review profile go to a nested adversarial review (realm @nick/craft, node #420):
// the review stays the one entry on any language, and its answer stays one — one verdict, the worse of the two,
// and one report with the nested part labelled. Runs after the coverage phase (src/review.js).
import { nestedWorkflow } from './nested-workflow.mjs'
import { resolveProfilePin, supportedLangLabel } from './review-coverage.mjs'
import { PROFILES } from './review-profiles.mjs'
import { memoryRecord } from './memory-recall.mjs'
import { summarizeFindings } from './run-record.mjs'
import { honestVerdict, honestVerdictLine } from './honest-verdict.mjs'
import { readNested, combinedVerdict, raiseVerdictLine, nestedSection, nestedRecord, NESTED_ENGINE } from './review-nested-verdict.mjs'

/**
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-nested-verdict.mjs').NestedOutcome} NestedOutcome
 * @typedef {import('./review-run.mjs').Coverage} Coverage
 * @typedef {(name: string, args: unknown) => Promise<unknown>} Launch  the sandbox's `workflow`
 */

/**
 * Why the uncovered files stay unreviewed here, or '' when they may go to the nested run. Nested itself (one
 * level only) or pinned to a language (the caller asked for that profile alone) — the review then names them as
 * uncovered, as before. A `repo` does not bar it: the nested engine takes it too (realm @nick/craft, node #415).
 * @param {ReviewRun} reviewRun @returns {string}
 */
export function nestingBarred(reviewRun) {
  if (reviewRun.viaArg) return `this review is itself nested (under ${reviewRun.viaArg}), and nesting is one level only`
  if (resolveProfilePin(PROFILES, reviewRun.requestedLangs).pinned) return 'the review is pinned to a language'
  return ''
}

/**
 * The nested run's arguments: the whole base of the review on every round — it keeps no memory, so a delta round
 * would drop its earlier findings unseen — the files it is to look at, the checkout they are in (`repo`, when the
 * review's is not the session's own), and `_via` so its record says nested.
 * @param {ReviewRun} reviewRun @param {string[]} files @param {string} baseRef @returns {Record<string, unknown>}
 */
export function nestedLaunchArgs(reviewRun, files, baseRef) {
  const base = baseRef || reviewRun.baseArg
  const prior = reviewRun.A['priorDecisions']
  return {
    ...(base ? { diffBase: base } : {}), files, _via: 'review',
    ...(reviewRun.repoArg ? { repo: reviewRun.repoArg } : {}),
    ...(reviewRun.intentArg ? { intent: reviewRun.intentArg } : {}),
    ...(reviewRun.craftRootArg ? { craftRoot: reviewRun.craftRootArg } : {}),
    ...(Array.isArray(prior) ? { priorDecisions: prior } : {}),
  }
}

/**
 * @param {ReviewRun} reviewRun @param {Launch} launch @param {string} engine @param {string[]} files @param {string} baseRef
 * @returns {Promise<NestedOutcome>}
 */
async function runNested(reviewRun, launch, engine, files, baseRef) {
  const logLine = reviewRun.sb.log
  logLine(`Outside every profile → nested ${engine}: ${files.join(', ')}`)
  try {
    return readNested(await nestedWorkflow(launch, engine, nestedLaunchArgs(reviewRun, files, baseRef), logLine), files)
  } catch (e) {
    return readNested(null, files, String(/** @type {{ message?: unknown }} */ (e)?.message ?? e) || 'no message')
  }
}

/**
 * Every record and report of the run, from here on, carries the nested part: the record its verdict raised and its
 * classes in notRun, under `nestedReview`; the report its verdict line raised and the labelled section.
 * @param {ReviewRun} reviewRun @param {NestedOutcome} nested
 */
function joinNested(reviewRun, nested) {
  const { logRun, out, postComments } = reviewRun
  reviewRun.logRun = rec => logRun({ ...rec, verdict: combinedVerdict(String(rec['verdict'] ?? ''), nested), notRun: [...(Array.isArray(rec['notRun']) ? rec['notRun'] : []), ...nested.own], nestedReview: nestedRecord(nested) })
  reviewRun.out = text => out(honestVerdictLine(raiseVerdictLine(text, nested), nested.own) + nestedSection(nested, postComments))
}

/**
 * A diff no profile covers, wholly through the nested run: its verdict is the review's, never a bare INCOMPLETE
 * for want of a profile. @param {ReviewRun} reviewRun @param {NestedOutcome} nested @param {{ changedFiles: string[], notes: string }} change
 */
async function nestedOnlyExit(reviewRun, nested, { changedFiles, notes }) {
  const { craftVersion, scopeNotRun, scopeSection, logRun, out, extraLensesNotRun, depthRecordFields, postComments } = reviewRun
  const notRun = [...nested.own, ...scopeNotRun, ...extraLensesNotRun('no language profile covers the diff')]
  const verdict = honestVerdict(nested.ran ? nested.core : 'INCOMPLETE', notRun)
  await logRun({
    schemaVersion: 1, runtime: 'claude-code', craftVersion, kind: 'workflow', name: 'review', nested: false, via: null, memory: memoryRecord(reviewRun.memory),
    languages: [], verdict, findings: summarizeFindings([]), dimensions: [], verification: null,
    uncoveredFiles: changedFiles.filter(f => !nested.files.includes(f) || !nested.ran), notRun, nestedReview: nestedRecord(nested),
    ...depthRecordFields(), outputTokens: reviewRun.sb.budget.spent(),
  })
  const mark = { Block: '⛔ Block', Warning: '⚠️ Warning', Approve: '✅ Approve', INCOMPLETE: '⚠️ INCOMPLETE' }[nested.ran ? nested.core : 'INCOMPLETE']
  return out(honestVerdictLine([
    `## Verdict`, `${mark} — no language profile covers the diff (this engine's profiles: ${supportedLangLabel(PROFILES)}); its ${nested.files.length} source file(s) went to a nested ${NESTED_ENGINE}, whose verdict this is.`,
    ``, `## Detected`, notes || `${changedFiles.length} changed file(s)`,
  ].join('\n'), notRun) + nestedSection(nested, postComments) + scopeSection())
}

/**
 * The coverage after the nested run: the files it reviewed leave the uncovered lists; a nested run that did not
 * happen leaves them there and adds its class. Returns the exit when the whole diff went to it.
 * @param {ReviewRun} reviewRun @param {Launch} launch  the sandbox's `workflow` @param {string} engine  the nested engine's bare name
 * @param {Coverage} coverage
 * @param {{ baseRef: string, changedFiles: string[], notes: string }} change
 * @returns {Promise<{ exit: string } | { exit: null, active: Coverage['active'], uncoveredFiles: string[], uncoveredGap: string[] }>}
 */
export async function nestedPhase(reviewRun, launch, engine, coverage, { baseRef, changedFiles, notes }) {
  const { active, uncoveredFiles } = coverage
  const uncoveredGap = coverage.uncoveredGap.map(String)
  const barred = uncoveredGap.length ? nestingBarred(reviewRun) : ''
  if (barred) reviewRun.sb.log(`Not sent to a nested ${NESTED_ENGINE}: ${barred}`)
  if (!uncoveredGap.length || barred) return { exit: null, active, uncoveredFiles, uncoveredGap }
  const nested = await runNested(reviewRun, launch, engine, uncoveredGap, baseRef)
  if (coverage.routeAll) return { exit: await nestedOnlyExit(reviewRun, nested, { changedFiles, notes }) }
  joinNested(reviewRun, nested)
  if (!nested.ran) return { exit: null, active, uncoveredFiles, uncoveredGap }
  return { exit: null, active, uncoveredFiles: uncoveredFiles.filter(f => !uncoveredGap.includes(f)), uncoveredGap: [] }
}
