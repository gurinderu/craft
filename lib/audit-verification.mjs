// Verification bookkeeping for the rust-audit `unused-crates` dimension: the find→verify pipeline
// dispatches one verifier per candidate, and the shapes those verifiers come back in decide both
// what the report says and what the run record persists. It lives here rather than inline in
// workflows/rust-audit.js because the death paths are exactly what nobody exercises by hand — this
// module is importable, so lib/audit-verification.test.mjs can drive every one of them; the
// workflow gets the same code back through the craft-inline fence.

// A verifier that DIED and a verifier that REFUTED both leave a candidate unconfirmed, and folding
// them together is the failure this module exists to prevent: a refutation is a judgement somebody
// made, a death is a hole where no judgement happened.
//
// The load-bearing detail: `agent()` RESOLVES to null when the subagent dies on a terminal API
// error or is skipped (it only throws on budget exhaustion) — the same contract `safeAgent` tests
// with `if (res != null)`. So a bare `.then(v => ({ c, v }))` wraps a death into a TRUTHY object,
// `filter(Boolean)` drops nothing, and every dead verifier is silently counted as a refutation.
// Wrapping through here keeps the null a null all the way to the tally.
export function wrapVerdict(c, v) {
  return v == null ? null : { c, v }
}

// Fraction of candidates that must have been JUDGED (confirmed or refuted) for the dimension to
// claim it verified anything. Below it the surface is mostly unexamined and the dimension reports
// INCOMPLETE rather than a green.
//
// Why a fraction rather than "any death at all": one flaky agent in a large fan-out is the ordinary
// weather of this engine, and a marker that fires on every run stops being read. Why not the old
// "only when EVERY verifier died": 3 deaths out of 4 is not one flaky agent, and the audit table
// rendered that run as a green dimension over a surface nobody looked at. Half is the line: at or
// above it a majority of the candidates carry a real judgement, below it the summary would be
// speaking mostly about candidates nothing was established for.
export const VERIFY_MIN_JUDGED = 0.5

// Split the settled verifier results into judgements and holes. `verdicts` is what `parallel()`
// returns for the per-candidate thunks: `{ c, v }` for a verifier that answered, null for one that
// died (resolved-null, kept null by wrapVerdict; or threw, which parallel() turns into null).
export function tallyVerification(candidates, verdicts) {
  const list = Array.isArray(candidates) ? candidates : []
  const alive = (Array.isArray(verdicts) ? verdicts : []).filter(Boolean)
  const confirmedItems = alive.filter(x => x && x.v && x.v.confirmedUnused)
  const judged = alive.length
  const died = list.length - judged
  return {
    candidates: list.length,
    judged,
    judgedItems: alive,
    died: died > 0 ? died : 0,
    confirmedItems,
    confirmed: confirmedItems.length,
    refuted: judged - confirmedItems.length,
    // Rate over what was actually JUDGED — never over the candidate count, which would charge the
    // deaths to the detector as if they had been refutations. Null when nothing was judged: there
    // is no rate, and 0 would read as "this lens refutes nothing".
    refuteRate: judged ? Math.round(((judged - confirmedItems.length) / judged) * 100) / 100 : null,
  }
}

// True when too few candidates were judged for the dimension's verdict to mean anything.
export function verificationIncomplete(t) {
  return t.candidates > 0 && t.judged < Math.ceil(t.candidates * VERIFY_MIN_JUDGED)
}

// The whole `unused-crates` dimension result, verdict included, derived from the candidates and the
// settled verifier results. `_verification` is the internal tally the run record projects.
export function unusedCratesResult(candidates, verdicts) {
  const t = tallyVerification(candidates, verdicts)
  const _verification = { candidates: t.candidates, confirmed: t.confirmed, refuted: t.refuted, died: t.died, judged: t.judged, refuteRate: t.refuteRate }
  const diedNote = t.died ? ` ${t.died} verifier(s) died — those candidates are UNVERIFIED, neither confirmed nor cleared.` : ''
  const confirmed = t.confirmedItems.map(x => ({
    severity: 'Medium',
    title: x.c.title,
    location: x.c.location || '',
    detail: `${x.v.evidence || ''}${x.v.removal ? `\nRemove: ${x.v.removal}` : ''}`.trim() || (x.c.detail || ''),
  }))
  if (verificationIncomplete(t)) {
    const unjudged = (Array.isArray(candidates) ? candidates : [])
      .filter(c => !t.judgedItems.some(x => x.c === c))
      .map(c => ({ severity: 'Info', title: `unverified: ${c.title}`, location: c.location || '', detail: `${c.detail || ''}\nVerification did not run for this candidate — it is neither confirmed unused nor cleared.`.trim() }))
    return {
      dimension: 'unused-crates',
      verdict: 'INCOMPLETE (not run)',
      summary: t.judged
        ? `${t.candidates} candidate(s) flagged, but only ${t.judged} verifier(s) returned — ${t.died} died. Most of the unused-crate surface is UNVERIFIED, not clean.`
        : `${t.candidates} candidate(s) flagged, but every verifier failed to return — none was confirmed OR refuted. The unused-crate surface is UNVERIFIED, not clean.`,
      findings: confirmed.concat(unjudged),
      _verification,
    }
  }
  return {
    dimension: 'unused-crates',
    verdict: confirmed.length ? 'Warning' : 'Approve',
    summary: `${t.candidates} candidate(s) flagged; ${t.confirmed} verified unused after trying to refute each; ${t.refuted} refuted (kept).${diedNote}`,
    findings: confirmed.length ? confirmed : [{ severity: 'Info', title: 'No verified unused crates', location: '', detail: `${t.candidates} candidate(s) flagged, ${t.refuted} refuted by verification.${diedNote}` }],
    _verification,
  }
}
