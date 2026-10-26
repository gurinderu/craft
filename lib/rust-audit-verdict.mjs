// How rust-audit reads its dimensions' verdicts (src/rust-audit.js): a nested review's report mapped onto a
// dimension result, an agent's free-text verdict mapped onto the aggregate's vocabulary, and the audit
// verdict over what did not run. Lifted out of the engine so the tests import it.
import { GREEN_VERDICT } from './audit-evidence.mjs'
import { honestVerdict } from './honest-verdict.mjs'
import { liftPriorDecisionSections } from './prior-decision-report.mjs'

// Map a rust-review workflow report string into a FINDINGS_SCHEMA-shaped dimension result.
// A review report has a stable shape: a `## Verdict` heading whose first non-empty following line
// IS the verdict. Classify on that line alone — the body legitimately contains ⚠️ and the word
// INCOMPLETE (the "Not reviewed" list, "Coverage gaps"), so a substring match over the whole report
// scored a plain Approve as a Warning and any mention of the word as uncovered. A report with no
// `## Verdict` heading is one we cannot read, and the non-permissive default applies.
/** @param {unknown} reportIn */
export function verdictLine(reportIn) {
  const text = String(reportIn || '')
  const m = /^[ \t]*#{1,6}[ \t]*Verdict\b(.*)$/im.exec(text)
  if (!m) return null
  // The verdict is sometimes written INLINE on the heading (`## Verdict: ⛔ Block — 2 High`). Reading
  // past the heading line then landed on the NEXT heading, which matches nothing, so a Block was
  // reported as "verdict could not be read" and downgraded to Warning. When the heading line itself
  // carries text after `Verdict`, that text IS the verdict; only otherwise look below it.
  const inline = String(m[1] || '').replace(/^[\s:：—–-]+/, '').trim()
  if (inline) return inline
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return null
}

/** @param {string | null} line @param {boolean} incomplete @returns {string} */
function reviewVerdict(line, incomplete) {
  if (line == null) return 'Warning'
  if (/⛔|Block/.test(line)) return 'Block'
  if (/⚠️|Warning/.test(line)) return 'Warning'
  if (incomplete) return 'Warning'
  return /✅|Approve/.test(line) ? 'Approve' : 'Warning'
}

// The summary reads the SAME `incomplete` flag as the verdict, so the two can never diverge on
// it: a `⛔ Block (INCOMPLETE)` is a Block AND carries the partial-coverage clause, never a bare
// "uncovered" that would report one dimension as both a Block and a mere absence of coverage.
/** @param {string | null} line @param {string} verdict @param {boolean} incomplete @returns {string} */
function reviewSummary(line, verdict, incomplete) {
  if (line == null) return 'Deep review verdict could not be read — this dimension is unverified, not clean.'
  if (verdict === 'Block') return `Deep review returned a BLOCK — blocking findings below${incomplete ? '; coverage was also partial, so there may be more' : ''}.`
  return incomplete
    ? 'Deep review did NOT run to completion — this dimension is uncovered, not clean.'
    : 'Elastic deep review — see findings below.'
}

/**
 * @param {string} dimension
 * @param {unknown} reportIn
 */
export function reviewResult(dimension, reportIn) {
  const line = verdictLine(reportIn)
  // A coverage-hole clause voids an otherwise-green verdict whether the engine spelled it INCOMPLETE
  // (a genuine not-run) or PARTIAL COVERAGE (files no language profile covered) — review.js writes both
  // via verdictSuffix (lib/review-coverage.mjs), and the model may drop the ⚠️ glyph when it rewrites
  // the verdict line, so this classifies on the WORDS, not the emoji. It matches both markers, the same
  // widening lib/analyze-runs.mjs's isIncomplete carries, so this reader and the run store never
  // disagree — and it drives BOTH the verdict step below and the summary, which can then never diverge.
  const incomplete = /INCOMPLETE|PARTIAL COVERAGE/i.test(line || '')
  // SEVERITY FIRST, then coverage — the same rule lib/analyze-runs.mjs states and implements for the
  // run store, and the two must not disagree. A `⛔ Block (INCOMPLETE)` is a block: partial coverage
  // cannot un-find a finding that was already made, so it must not be downgraded to Warning. Only an
  // otherwise-green verdict is voided by incompleteness, because an Approve is a claim about what was
  // NOT found and holds only over what was actually looked at. Anything unreadable is Warning.
  const verdict = reviewVerdict(line, incomplete)
  const summary = reviewSummary(line, verdict, incomplete)
  const kept = liftPriorDecisionSections(String(reportIn || 'no report'))
  return {
    dimension,
    verdict,
    summary,
    findings: [{ severity: 'Info', title: 'Deep review report', location: '', detail: kept.rest.slice(0, 4000) }],
    ...(kept.lifted ? { _priorDecisions: kept.lifted } : {}),
  }
}

// Free text in, vocabulary out: map an agent's verdict onto the aggregate's language. Greenness is
// GREEN_VERDICT (lib/audit-evidence.mjs — the one green authority the evidence gate shares); a match
// becomes Approve. INCOMPLETE passes through untouched; anything genuinely
// unrecognisable is returned UNCHANGED, so it still lands in the non-permissive branch of
// worstVerdict — this widens the green vocabulary, it never weakens the default.
/** @param {unknown} v model output */
export function normalizeDimensionVerdict(v) {
  const t = String(v == null ? '' : v).trim()
  if (!t) return t
  if (/INCOMPLETE/i.test(t)) return t
  // Green FIRST, and only on a WHOLE-string match: "No UB found" is a clean miri answer, while the
  // red pattern's `ub[- ]found` would otherwise read it as a Block. Requiring the whole string keeps
  // "OK, but 2 blocking findings" out of the green branch — it falls through to the red test below.
  if (GREEN_VERDICT.test(t)) return 'Approve'
  if (/\b(block(ing|ed)?|at[- ]risk|ub[- ]found|found ub|fail(ed|ure|ing)?|critical)\b/i.test(t)) return 'Block'
  if (/\b(warn(ing)?s?|concerns?|caution)\b/i.test(t)) return 'Warning'
  return t
}

// The audit verdict carries an (INCOMPLETE) marker when any dimension failed to run OR could not
// run (its tooling was absent, so it checked nothing) — unless the aggregate is already an
// INCOMPLETE verdict in its own right.
/**
 * @param {string} worst
 * @param {unknown[]} notRunIn
 */
export function auditVerdict(worst, notRunIn) {
  return honestVerdict(worst, notRunIn)
}
