// ================= The per-agent deadline as a BUDGET, not a per-attempt allowance =================
// `ragent` dispatches an agent, races it against a wall-clock deadline, and on a fire abandons the
// wait and re-dispatches once. The deadline was computed once and handed to EACH attempt in full, so
// one verification entry's worst case was two full phase deadlines of waiting — 2×30min for Verify,
// 2×90min for a lens — and the first of those two waits is already spent inside a bounded window
// slot that a live verifier could have used.
//
// Making it one budget shared by the attempts halves that worst case without touching a single
// threshold, which matters: the thresholds are calibrated against a MEASURED live distribution
// (verifiers to 811s, one legitimate lens to 46 minutes) and a value tight enough to catch a hang
// (1000–1326s) sits inside that distribution and would kill real work. So the values stay and the
// ARITHMETIC changes.
//
// What the two attempts are for survives intact, and the asymmetry is the point rather than a side
// effect. The re-dispatch exists for `agent()` resolving null — an API death, which arrives FAST and
// therefore spends almost none of the budget, leaving the second attempt nearly the whole of it. A
// deadline fire is the opposite: it spends the budget by definition, so it no longer buys a second
// wait of the same length. Re-dispatching after a hang was always the weaker case anyway — a hang is
// evidence about the request, not about reachability.
//
// PURITY IS THE CONTRACT (as in lib/review-waves.mjs): the clock is injected, nothing logs, and the
// module is pasted back into the engine verbatim through a `craft-inline` fenced region.

// One wall-clock budget, consumed by however many attempts are made against it. `now` is injected so
// a test can drive elapsed time without sleeping; the engine passes nothing and gets `Date.now`.
export function makeDeadlineBudget(totalMs, now = Date.now) {
  const total = Number(totalMs)
  const started = now()
  const capped = Number.isFinite(total) && total > 0 ? total : 0
  // Clamped at zero from below: a clock that jumps backwards must not hand out MORE budget than the
  // total, and one that jumps forward must not hand out a negative timeout (setTimeout reads a
  // negative delay as zero, which would fire the deadline instantly and look like a hang).
  const remaining = () => Math.min(capped, Math.max(0, capped - (now() - started)))
  return {
    remaining,
    // Whether another attempt has any USABLE wall clock left to wait in. The refusal is a FLOOR,
    // not zero, and the difference is the whole point: an attempt dispatched against 200ms fires its
    // deadline before the agent can answer, so it costs a harness slot and produces nothing — which
    // is precisely the outcome the guard exists to prevent, arriving through a remainder that a
    // `<= 0` test reads as plenty. A slow death (the measured 500–660s form) lands exactly there.
    // The floor is the caller's to choose and is a POLICY DECISION, not a measurement: nothing
    // recorded derives a particular value. It defaults to zero so the bare call keeps its old
    // meaning for any caller that wants literally-nothing-left.
    exhausted: (floorMs = 0) => remaining() <= Math.max(0, Number(floorMs) || 0),
    total: () => capped,
  }
}
