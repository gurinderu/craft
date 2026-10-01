// ================= Merging per-profile results into run-level gate fields =================
// A review runs one profile per active language and files ONE record, so two per-profile facts are
// folded into run-level fields here: the gate status and whether any lens phase actually ran.
// The two must be read together (realm @nick/craft #103): the merged status is worst-of, so a mixed
// run where one profile failed its gate and another ran its lenses carries `status:'fail'` exactly
// like a run where every profile aborted — only `ranLenses` tells them apart.
//
// These live here, outside the workflow, for the same reason lib/review-waves.mjs does:
// workflows/review.js cannot be imported, so the merge is tested here and pasted back verbatim
// through a `craft-inline` fenced region. Pure: they read only the `results` they are given.

// Worst-of across profiles: any red gate blocks the whole review (findings can't be trusted on a
// broken tree); green only when every profile is green; anything else is unknown.
export function mergeGateStatus(results) {
  if (results.some(r => r.gateStatus === 'fail')) return 'fail'
  return results.every(r => r.gateStatus === 'pass') ? 'pass' : 'unknown'
}

// TRUE when any profile finished its lens phase. A gate-failed profile returns `ranLenses: []`,
// contributing nothing.
export function profilesRanLenses(results) {
  return results.some(r => (r.ranLenses || []).length > 0)
}
