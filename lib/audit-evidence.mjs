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

// The green verdicts across the three rubric vocabularies — Approve (review/security), Healthy
// (architecture), Clean (miri). ONLY these are gated: a green verdict is the overclaim the evidence
// requirement exists to stop. Warning/Block/At-risk/Concerns/UB-found and any INCOMPLETE already
// read as non-green downstream, so demoting them would say nothing and could double-count.
export const GREEN_DIMENSION_VERDICTS = ['Approve', 'Healthy', 'Clean']

// Whether `text` carries the marker AND something after it. Both empty readings the requirement
// names — marker absent, and marker present but nothing (only whitespace) after it — collapse into
// one indexOf + slice().trim() check. A non-empty sentence naming SOME work is all this proves; it
// does not prove the work happened (see the ceiling in the design, realm @nick/craft, node #53).
export function hasEvidence(text) {
  const t = String(text ?? '')
  const i = t.indexOf(EVIDENCE_MARKER)
  if (i < 0) return false                                         // marker absent
  return t.slice(i + EVIDENCE_MARKER.length).trim().length > 0    // marker present, nothing after it
}

// Demote a self-reported green with no evidence to INCOMPLETE, preserving the claimed word so the
// report says what was overclaimed. Only green verdicts are touched — a Warning/Block/INCOMPLETE is
// returned unchanged. The demoted string LEADS with `INCOMPLETE`, so it falls into the existing
// rollup (couldNotRun → worstVerdict → auditVerdict) with no change to any of them: an unsupported
// green becomes an INCOMPLETE dimension and, through the rollup, an INCOMPLETE audit.
export function demoteUnsupportedGreen(r) {
  if (!r || !GREEN_DIMENSION_VERDICTS.includes(r.verdict)) return r
  if (hasEvidence(r.evidence ?? r.summary)) return r
  return { ...r, verdict: `INCOMPLETE (no evidence — claimed ${r.verdict})` }
}
