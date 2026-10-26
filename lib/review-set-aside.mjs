// What leaves the verdict before synthesis (src/review.js, Synthesize phase): the run's not-run and coverage notes,
// the findings a recorded decision or question sets aside, those a project rule covers, and the exit when nothing survived.
import { MATCH_JUDGE_SCHEMA } from './prior-decision-match.mjs'
import { SCOPE_CHECK_SCHEMA, scopeCheckPrompt } from './prior-decision-scope.mjs'
import { applyPriorDecisions } from './prior-decision-apply.mjs'
import { RULE_JUDGE_SCHEMA } from './project-rule-judge.mjs'
import { applyProjectRules } from './project-rule-apply.mjs'
import { supportedLangLabel, uncoveredNotRunNote, verdictSuffix } from './review-coverage.mjs'
import { honestVerdict, honestVerdictLine } from './honest-verdict.mjs'
import { summarizeFindings, refuteRate } from './run-record.mjs'
import { PROFILES } from './review-profiles.mjs'
import { CULL_MODEL } from './review-verify-pool.mjs'
import { seamSetAsideSection } from './crate-seam.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The tiers with the set-aside findings out of them and the notes the verdict carries, or the report of the exit when nothing survived.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'tierLists' | 'results' | 'uncoveredGap' | 'adjudicated' | 'priorTombstones' | 'reviewRecord' | 'thisRound' | 'mergedGateStatus' | 'active' | 'mergedProvenance' | 'carriedSection' | 'uncoveredFiles'>} state
 */
export async function setAsidePhase(reviewRun, { tierLists, results, uncoveredGap, adjudicated, priorTombstones, reviewRecord, thisRound, mergedGateStatus, active, mergedProvenance, carriedSection, uncoveredFiles }) {
const { scopeNotRun, scopeSection, REPO_DIRECTIVE, limitStop, ragent, logRun, out, crateRuns } = reviewRun
const { log: logLine } = reviewRun.sb
let { confirmed, suspected, unverified } = tierLists
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
  ].join('\n'), notRun) + seamSetAsideSection(crateRuns) + scopeSection())
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
  for (const n of r.notes) logLine(`priorDecisions: ${n}`)
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
  for (const n of r.notes) logLine(`project rules: ${n}`)
}
await coverByProjectRules()
if (nothingSurvived()) return { exit: await noFindingsExit() }
return { exit: null, confirmed, suspected, unverified, priorRejected, priorRejectedLive, priorDisposition, ruleNotices, dropped, thinned, notRun, savedByFloor, coverageNotes, incompleteNotes, criticNotes }
}
