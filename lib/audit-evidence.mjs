// A green verdict is a claim about what was NOT found, and it only holds if something was actually
// looked at. A review agent that self-reports a passing verdict must therefore SHOW its work — a
// positive `Evidence:` line naming the concrete commands run, tools used, and files read this pass.
// This module is the runtime half of a white-list (invariant #53): a claimed-green dimension whose
// evidence field is empty is demoted to INCOMPLETE BY CONSTRUCTION, so an honest zero-finding pass
// can only stay green by saying what it did.
//
// It lives here rather than inline in workflows/rust-audit.js for the reason every craft-inline
// source does: the workflow sandbox cannot import, so the logic is tested here (lib/audit-evidence.
// test.mjs drives it, and the stitch test pins its marker to the parity gate's) and the workflow
// gets the same code back through the craft-inline fence. No imports — every craft-inline source in
// this repo is closure-free (lib/audit-verification.mjs is the precedent).

// The marker a review agent must emit before a passing verdict. Held IDENTICAL to the parity gate's
// EVIDENCE.field[0] (lib/check-delivery-parity.mjs) by a tripwire in the test — the static half that
// makes the rubrics carry the line and this runtime half that reads it must never disagree on what
// the marker IS.
export const EVIDENCE_MARKER = 'Evidence:'

// The ONE definition of "is this verdict a green claim" — the single source of green, used by every
// reader that must never disagree: normalizeDimensionVerdict() (workflows/rust-audit.js, which maps
// any match to Approve), demoteUnsupportedGreen() below (which gates a match for evidence), AND
// worstVerdict() (lib/run-record.mjs, the roll-up). The roll-up lives in a DIFFERENT closure-free
// inline module and so cannot import this regex (no craft-inline source has an import); it carries a
// byte-identical copy instead, pinned to this one by a tripwire in lib/run-record.test.mjs — the same
// discipline as EVIDENCE_MARKER's stitch. In the assembled workflows/rust-audit.js there is exactly
// ONE GREEN_VERDICT (this one, via the audit-evidence fence) and all three readers resolve to it.
// It spans the three rubric vocabularies — Approve (review/security), Healthy (architecture), Clean
// (miri) — AND the off-vocabulary greens agents still emit despite the schema enum ("Pass", "OK",
// "no issues found", "all clear", "none found", …). Anchored whole-string, so "OK, but 2 blocking
// findings" and "Approve — all clean" are NOT green (a trailing clause is not a bare green word).
// Only a green is gated: a green verdict is the overclaim the evidence requirement exists to stop;
// Warning/Block/At-risk/Concerns/UB-found and any INCOMPLETE already read as non-green downstream, so
// demoting them would say nothing. (realm @nick/craft, node #53)
export const GREEN_VERDICT = /^(approve[ds]?|healthy|clean|pass(ed|ing)?|ok(ay)?|fine|good|green|no ub( (detected|found))?|no (issues|findings|problems|defects)( (detected|found))?|none( found)?|nothing (found|to report)|all (clear|good))[\s.!—–-]*$/i

// Whether some LINE of `text` begins with the marker and carries content after it. Line-anchored on
// purpose (mirrors the rubric "emit one line beginning `Evidence:`"): a bare `indexOf` matched the
// marker buried in a finding's prose ("no `Evidence:` of bounds") or in a quoted instruction, waving
// a no-work green through. Both empty readings the requirement names — marker absent, and marker
// beginning a line but nothing after it — still return false. A non-empty sentence naming SOME work
// is all this proves; it does not prove the work happened (the ceiling, realm @nick/craft, node #53).
export function hasEvidence(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    const i = line.search(/\S/)                                   // first non-whitespace column
    if (i < 0 || !line.startsWith(EVIDENCE_MARKER, i)) continue   // line does not begin with the marker
    if (line.slice(i + EVIDENCE_MARKER.length).trim().length > 0) return true  // content follows it
  }
  return false
}

// Demote a self-reported green with no evidence to INCOMPLETE, preserving the claimed word so the
// report says what was overclaimed. Greenness is decided by GREEN_VERDICT — the SAME test
// normalizeDimensionVerdict() uses — so an off-vocabulary green ("Pass", "no issues found") is gated
// exactly like the canonical "Approve", not waved through here to be normalized into a clean green a
// step later (realm @nick/craft, node #53). Only a green is touched — a Warning/Block/INCOMPLETE is
// returned unchanged, and the demoted string itself leads with `INCOMPLETE`, so it is idempotent and
// falls into the existing rollup (couldNotRun → worstVerdict → auditVerdict) with no change to any of
// them: an unsupported green becomes an INCOMPLETE dimension and, through the rollup, an INCOMPLETE audit.
export function demoteUnsupportedGreen(r) {
  if (!r || !GREEN_VERDICT.test(String(r.verdict ?? ''))) return r
  // `||`, not `??`: FINDINGS_SCHEMA makes `evidence` required, so an agent that put its Evidence line
  // in the report BODY (as the rust-security-scanner / rust-miri rubrics instruct — a line, not "fill
  // the field") leaves the STRUCTURED field present-but-empty (''). `??` would keep that '' and never
  // consult the summary where the line may live, demoting honest work; '' is exactly the value the
  // fallback exists to skip past. hasEvidence is line-anchored, so the line is found in either.
  if (hasEvidence(r.evidence || r.summary)) return r
  return { ...r, verdict: `INCOMPLETE (no evidence — claimed ${r.verdict})` }
}
