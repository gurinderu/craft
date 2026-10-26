// Sorting before publication (src/review.js, Synthesize phase; realm @nick/craft, nodes #270, #271, #277): with
// `comment`, the defects posted on the PR and the doubtful findings kept for the reviewer.
import { findingCommentBody } from './finding-comment.mjs'
import { DIFF_LINES_SCHEMA, diffLinesPrompt, readDiffLines } from './diff-lines.mjs'
import { sortFindings, postable, doubtfulSection } from './finding-sort.mjs'
import { contradictionRecord } from './memory-contradiction.mjs'
import { fingerprint } from './run-record.mjs'
import { shq } from './run-logging.mjs'
import { PR_COMMENTS_SCHEMA } from './review-schemas.mjs'
import { CULL_MODEL } from './review-verify-pool.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 */
/** @typedef {import('./review-run.mjs').ReviewState} ReviewState */

/**
 * The sorting's record, its report section and the memory-contradiction count, after the defects were posted.
 * @param {ReviewRun} reviewRun
 * @param {Pick<ReviewState, 'tierLists' | 'baseRef'>} state
 */
export async function sortingPhase(reviewRun, { tierLists, baseRef }) {
const { postComments, REPO_DIRECTIVE, ragent } = reviewRun
const { log: logLine } = reviewRun.sb
const { confirmed, suspected } = tierLists
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
  if (note) logLine(`⚠️ sorting: ${note}`)
  const sorted = { ...sortFindings(candidates, changed), note, candidates, changed }
  logLine(`sorting: ${sorted.defect.length} defect(s) to post, ${sorted.doubtful.length} doubtful for the reviewer`)
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
    if (posted == null) logLine(`⚠️ PR comments: the poster agent returned nothing — ${defects.length} Confirmed finding(s) may or may not have been posted; check the PR`)
    else if (Number(posted.posted) > 0) logLine(`PR comments: posted ${Number(posted.posted)} of ${defects.length} Confirmed finding(s) — ${posted.reason || 'no detail'}`)
    else logLine(`⚠️ PR comments: nothing was posted (${defects.length} Confirmed finding(s) requested) — ${posted.reason || 'no reason given'}`)
  }
}
await postPrComments()
return { sortingRecord, contradictionsRecord, doubtfulReport }
}
