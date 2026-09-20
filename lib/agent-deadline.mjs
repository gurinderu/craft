// ================= The per-agent deadline as a BUDGET, not a per-attempt allowance =================
// `ragent` dispatches an agent, races it against a wall-clock deadline, and on a fast death
// re-dispatches once. The deadline used to be computed once and handed to EACH attempt in full, so
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
// THERE IS NO CLOCK HERE, AND THAT IS NOT A STYLE CHOICE. Observed by running a probe inside the
// workflow sandbox on 2026-09-19: `Date.now`, `new Date`, `performance` and `process` are all
// unavailable — the host refuses a clock outright, because a resumed workflow must replay to the
// same result and a clock reading cannot. `setTimeout` is the one time-shaped primitive the probe
// tested for and found. `clearTimeout` is used here too and was NOT part of that probe: it is
// attested only indirectly, by 123 dispatches of a real run whose every `dispose()` ran without
// throwing. Said plainly rather than folded into the sentence above, because the next reader would
// otherwise take it for something that was checked.
// An earlier version of this module defaulted to `Date.now` and passed every gate: the checkers
// compile the engine, they do not run it, so the engine died on its FIRST agent dispatch in a real
// run while 849 tests stayed green. That is why this is expressed in timers.
//
// So the budget is not measured, it is ARMED. One timer is started when the budget is created and
// every attempt races against that SAME promise — which is the literal meaning of "one budget shared
// by the attempts", rather than an arithmetic reconstruction of it. A second timer marks the point
// past which a re-dispatch has too little left to be worth a harness slot.
//
// What the two attempts are for survives intact, and the asymmetry is the point rather than a side
// effect. The re-dispatch exists for `agent()` resolving null — an API death, which arrives FAST and
// therefore consumes almost none of the budget, leaving the second attempt nearly all of it. A
// deadline fire is the opposite: it IS the budget running out, so there is nothing to re-dispatch
// into. Re-dispatching after a hang was always the weaker case anyway — a hang is evidence about the
// request, not about reachability.
//
// PURITY IS THE CONTRACT (as in lib/review-waves.mjs): the scheduler is injected, nothing logs, and
// the module is pasted back into the engine verbatim through a `craft-inline` fenced region.

// One wall-clock budget, armed once and shared by however many attempts race against it.
//
// `totalMs` is the whole budget; `floorMs` is how much of its tail is too little for another attempt
// to be launched into — a re-dispatch there would fire the deadline before the agent could answer,
// costing a harness slot to produce nothing. `schedule` is injected so a test can fire the timers
// deterministically instead of sleeping; the engine passes nothing and gets `setTimeout`.
//
// Returns `expired` and `belowFloor` as QUESTIONS rather than numbers on purpose: with no clock
// there is no honest "remaining", and a function that invented one would be read as a measurement.
export function makeDeadlineBudget(totalMs, { floorMs = 0, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const total = Number(totalMs)
  const capped = Number.isFinite(total) && total > 0 ? total : 0
  const floor = Math.max(0, Math.min(capped, Number(floorMs) || 0))

  let expired = capped === 0
  let belowFloor = capped === 0 || floor >= capped
  let resolveHit = null
  const timers = []

  // The single promise every attempt races. It is created once, so a second attempt inherits
  // whatever is left of the first one's wait rather than starting a fresh one — no subtraction, no
  // clock, and nothing to get wrong when the host's timers drift.
  const hit = capped === 0
    ? Promise.resolve(DEADLINE_HIT)
    : new Promise(resolve => { resolveHit = resolve })

  if (capped > 0) {
    timers.push(schedule(() => { expired = true; belowFloor = true; if (resolveHit) resolveHit(DEADLINE_HIT) }, capped))
    // Armed at the point where the REMAINING budget drops to the floor, so "below the floor" is a
    // moment the host tells us about rather than a subtraction we perform.
    if (floor > 0 && floor < capped) timers.push(schedule(() => { belowFloor = true }, capped - floor))
  }

  return {
    hit,
    // Whether the shared deadline has already fired. An attempt started now would race a promise
    // that is already resolved and return immediately.
    expired: () => expired,
    // Whether what is left is too short for another attempt to be worth dispatching. Always true
    // once the budget has fired, so a caller that asks only this one question is still correct.
    belowFloor: () => belowFloor,
    total: () => capped,
    // Clears the armed timers. Without it a pending timer holds the run open for the whole deadline
    // after the agent has already answered — invisible while a throw killed the run outright, and a
    // real leak once the caller swallows that throw.
    dispose: () => { for (const t of timers) cancel(t) },
  }
}

// The sentinel the race resolves to when the budget runs out. Exported so the engine can compare
// identity rather than shape: a falsy or `{}`-shaped marker is indistinguishable from an agent that
// answered with nothing, and those two outcomes must never merge.
export const DEADLINE_HIT = { craftDeadline: true }
