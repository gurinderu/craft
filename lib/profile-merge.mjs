// ================= Merging per-profile results into run-level record fields =================
// A review runs one profile per active language and files ONE record, so per-profile facts are
// folded into the record's run-level `gate` and `surfaceGate` fields here. Two of them must be read
// together (realm @nick/craft #103): the merged gate status is worst-of, so a mixed run where one
// profile failed its gate and another ran its lenses carries `status:'fail'` exactly like a run
// where every profile aborted — only `surfaceGate.lensesRan` tells them apart.
//
// These live here, outside the workflow, for the same reason lib/review-waves.mjs does:
// workflows/review.js cannot be imported, so the merge and the field assembly are tested here and
// pasted back verbatim through a `craft-inline` fenced region. Pure: they read only their arguments.

// The profiles whose mechanical gate is red. One rule, shared by the early Block exit and the
// recorded gate status, so the run that aborted and the record that says it aborted cannot disagree.
export function failedProfiles(results) {
  return results.filter(r => r.gateStatus === 'fail')
}

// Worst-of across profiles: any red gate blocks the whole review (findings can't be trusted on a
// broken tree); green only when every profile is green; anything else is unknown.
export function mergeGateStatus(results) {
  if (failedProfiles(results).length) return 'fail'
  return results.every(r => r.gateStatus === 'pass') ? 'pass' : 'unknown'
}

// TRUE when any profile's `ranLenses` is non-empty. A gate-failed profile returns `ranLenses: []`,
// contributing nothing. `ranLenses` counts only lenses that returned on EVERY slice, so a profile
// whose every lens lost a slice reads as not-run here — an under-count of its saving, never an
// over-claim.
export function profilesRanLenses(results) {
  return results.some(r => (r.ranLenses || []).length > 0)
}

// The record's `gate` field: merged status, per-profile provenance, and red-but-not-ours checks.
export function gateRecord(results) {
  return {
    status: mergeGateStatus(results),
    provenance: results.map(r => `[${r.profile.id}] ${r.gateProvenance}`).join(' · '),
    carriedChecks: results.flatMap(r => (r.carriedChecks || []).map(c => `[${r.profile.id}] ${c}`)),
  }
}

// The run-level surface-gate saving (realm @nick/craft #102): the lenses the gate dropped in some
// profile that got PAST its mechanical gate, minus any lens that was dispatched in another profile.
// A gate-failed profile's drops are not savings — none of its lenses could have run — so counting
// them on a mixed run would over-claim. Each profile result carries its own `surfaceDropped`.
export function savedSurfaceDrops(results, dispatched) {
  const ran = new Set(dispatched)
  const dropped = new Set(results.filter(r => r.gateStatus !== 'fail').flatMap(r => r.surfaceDropped || []))
  return [...dropped].filter(l => !ran.has(l)).sort()
}

// The record's `surfaceGate` field: the saving above, the dispatched set, the critic-named lenses
// that are still in the saving (a named lens that ran somewhere is not a gap), and `lensesRan`.
export function surfaceGateRecord(results, { dispatched, namedByCritic }) {
  const dropped = savedSurfaceDrops(results, dispatched)
  const named = new Set(namedByCritic)
  return {
    dropped,
    dispatched: [...dispatched].sort(),
    namedByCritic: dropped.filter(l => named.has(l)),
    lensesRan: profilesRanLenses(results),
  }
}
