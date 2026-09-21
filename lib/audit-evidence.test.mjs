import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVIDENCE_MARKER, GREEN_VERDICT, hasEvidence, demoteUnsupportedGreen } from './audit-evidence.mjs'
import { EVIDENCE } from './check-delivery-parity.mjs'
import { unusedCratesResult, wrapVerdict, tallyVerification, unusedEvidence } from './audit-verification.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- hasEvidence: the two empty readings, and the two non-empty ones ----

test('hasEvidence is false when the marker is absent', () => {
  assert.equal(hasEvidence('ran cargo test — all green'), false)
  assert.equal(hasEvidence(''), false)
  assert.equal(hasEvidence(null), false)
  assert.equal(hasEvidence(undefined), false)
})

test('hasEvidence is false when the marker is present but nothing follows it', () => {
  assert.equal(hasEvidence('Evidence:'), false)
  assert.equal(hasEvidence('Evidence:   '), false)
  assert.equal(hasEvidence('Evidence:\n\n'), false)
})

test('hasEvidence is true when the marker carries content after it', () => {
  assert.equal(hasEvidence('Evidence: ran cargo-audit, cargo-deny; both clean'), true)
  // The marker anywhere in the text, with content after it, counts.
  assert.equal(hasEvidence('## Verdict\nApprove\nEvidence: read src/db.rs'), true)
})

// ---- demoteUnsupportedGreen: only green, only when unsupported ----

test('a green verdict with no evidence is demoted to INCOMPLETE, keeping the claimed word', () => {
  // Canonical AND off-vocabulary greens. The gate must catch the words agents still emit despite the
  // schema enum — "Pass", "OK", "no issues found", "all clear", "No UB found" — because those are
  // exactly the sloppy reports the evidence requirement targets. The greenness test is GREEN_VERDICT,
  // the SAME one normalizeDimensionVerdict uses, so an off-vocabulary green cannot slip the gate and
  // then be normalized into a clean Approve downstream. The claimed word is preserved verbatim.
  for (const verdict of ['Approve', 'Healthy', 'Clean', 'Pass', 'OK', 'no issues found', 'all clear', 'No UB found']) {
    const r = demoteUnsupportedGreen({ dimension: 'x', verdict, summary: 'looks fine', findings: [], evidence: '' })
    assert.equal(r.verdict, `INCOMPLETE (no evidence — claimed ${verdict})`, `${verdict} with no evidence is demoted`)
  }
})

test('GREEN_VERDICT is the single greenness authority — it spans the vocabulary and rejects reds', () => {
  for (const v of ['Approve', 'Healthy', 'Clean', 'Pass', 'OK', 'no issues found', 'all clear', 'No UB found', 'none found']) {
    assert.ok(GREEN_VERDICT.test(v), `${v} is green`)
  }
  for (const v of ['Warning', 'Block', 'At-risk', 'Concerns', 'UB-found', 'INCOMPLETE (not run)', 'OK, but 2 blocking findings']) {
    assert.ok(!GREEN_VERDICT.test(v), `${v} is not green`)
  }
})

test('a green verdict WITH evidence is left untouched (the false-positive control)', () => {
  const r = { dimension: 'security', verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran cargo-audit' }
  assert.equal(demoteUnsupportedGreen(r), r, 'the same object is returned, unchanged')
})

test('demoteUnsupportedGreen falls back to the summary when there is no evidence field', () => {
  const withMarker = demoteUnsupportedGreen({ verdict: 'Approve', summary: 'Evidence: ran the tool' })
  assert.equal(withMarker.verdict, 'Approve', 'a summary carrying the marker keeps the green')
  const without = demoteUnsupportedGreen({ verdict: 'Approve', summary: 'nothing to report' })
  assert.match(without.verdict, /INCOMPLETE \(no evidence/, 'a summary with no marker demotes')
})

test('a non-green verdict is never touched — no evidence required of it', () => {
  for (const verdict of ['Warning', 'Block', 'At-risk', 'Concerns', 'UB-found', 'INCOMPLETE (not run)']) {
    const r = { dimension: 'x', verdict, summary: 's', findings: [], evidence: '' }
    assert.equal(demoteUnsupportedGreen(r), r, `${verdict} is returned unchanged`)
  }
})

test('a null/garbage result is returned unchanged, not crashed on', () => {
  assert.equal(demoteUnsupportedGreen(null), null)
  assert.equal(demoteUnsupportedGreen(undefined), undefined)
})

// ---- the stitch: the static half and the runtime half must name the same marker ----
// Modeled on the OUTCOMES tripwire in check-delivery-parity.mjs: if either constant is reworded
// alone, this fails, so the rubric-required line and the runtime-read line can never disagree.
test('the rubric-required marker and the runtime-read marker are the same string', () => {
  assert.equal(EVIDENCE.field[0], EVIDENCE_MARKER)
})

// ---- the computed unused-crates green carries its own evidence, so the gate does not demote it ----
// unused-crates is gated by default (unlike the review axes), but its verdict is COMPUTED from the
// verification tally, not self-reported — the same shape as the review dimension. So it emits its own
// `Evidence:` line and a genuinely-verified all-refuted Approve survives the gate.
test('a verified all-refuted unused-crates Approve is not demoted (it carries computed evidence)', () => {
  const cs = [{ title: 'orphan-member: a', location: 'a/Cargo.toml', detail: 'x' }, { title: 'orphan-member: b', location: 'b/Cargo.toml', detail: 'y' }]
  const refute = { confirmedUnused: false, evidence: 'used behind a feature gate' }
  const result = unusedCratesResult(cs, cs.map(c => wrapVerdict(c, refute)))
  assert.equal(result.verdict, 'Approve', 'all refuted → a green Approve')
  assert.ok(hasEvidence(result.evidence), 'the computed result carries an Evidence line')
  assert.equal(demoteUnsupportedGreen(result).verdict, 'Approve', 'so the gate does not demote it')
})

// ---- the zero-candidate clean pass carries computed evidence too (the workflow's candidates:0 branch) ----
// The unused-crates find prompt has no `Evidence:` clause, so a clean pass with no candidates would
// self-report an empty evidence field and be demoted. The workflow branch injects
// unusedEvidence(tallyVerification([], [])) for a green instead; this pins the helpers it composes.
test('a zero-candidate clean unused-crates pass carries computed evidence and survives the gate', () => {
  const t = tallyVerification([], [])
  const computed = unusedEvidence(t)
  assert.ok(hasEvidence(computed), 'the zero-candidate tally emits a non-empty Evidence line')
  const green = { dimension: 'unused-crates', verdict: 'Approve', findings: [], evidence: computed }
  assert.equal(demoteUnsupportedGreen(green).verdict, 'Approve', 'so an honest clean pass is not demoted')
  // The falsifier: the same green WITHOUT the computed evidence — what the old branch returned — demotes.
  const bare = { dimension: 'unused-crates', verdict: 'Approve', findings: [], evidence: '' }
  assert.match(demoteUnsupportedGreen(bare).verdict, /INCOMPLETE \(no evidence/)
})

// ---- nix-reviewer's copy of the marker is NOT parity-enforced (no OpenCode pair) ----
// check-delivery-parity's pairing walk returns early for UNPAIRED_BY_DESIGN names, so nix-reviewer's
// `evidence` group is never compared and a dropped `Evidence:` line there would be silent under that
// gate. This direct assertion covers exactly the file the pairing walk cannot reach.
test('agents/nix-reviewer.md carries the Evidence marker (unreachable by the parity pairing walk)', () => {
  const body = fs.readFileSync(path.join(ROOT, 'agents', 'nix-reviewer.md'), 'utf8')
  assert.ok(body.includes(EVIDENCE_MARKER), 'nix-reviewer must carry the Evidence marker directly')
})
