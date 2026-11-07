// The review engine's per-agent wall-clock deadlines (src/review.js): the per-phase table, the caller's
// override and the floor a re-dispatch may be launched into.

// ---- per-agent wall-clock deadline ----
// The retry above only fires when agent() RESOLVES to null. An agent whose request hangs mid-response
// never resolves and never throws, so nothing above catches it. A measured run lost 64 minutes — a
// third of its wall clock — to six agents frozen inside one `parallel()` barrier, and then died
// without writing anything. The fix is to stop WAITING, not to wait more cleverly.
//
// Honest limit: the sandbox exposes setTimeout/clearTimeout but no AbortController, so losing the
// race abandons the wait without cancelling the agent — a hung one keeps its concurrency slot until
// the harness reaps it. That is still the difference between a phase that proceeds shorthanded and a
// review that stops dead, which is what actually happened.
//
// The clock starts at DISPATCH, so a deadline covers queue wait PLUS execution — not execution
// alone. Calibrating against execution time was a real and expensive mistake: Verify sat at 15min
// against an 811s measured maximum, then a ~130-thunk wave queued agents for a quarter of an hour
// before they ran, the deadline fired on agents that were merely waiting, and 23 findings cost 172
// verification agents. Dispatch is windowed now (VERIFY_WINDOW_AGENTS), which caps the queue term — and
// these numbers are set against the SUM: ~24 agents dispatched in flight over an execution p90 of
// ~360s is well under 15min of waiting, so 30min leaves real headroom above both parts. The window
// bounds DISPATCH, not occupancy: the re-dispatch below leaves the abandoned agent holding its
// harness slot, so occupancy can transiently reach ~48 — but only after a 30min deadline, so it
// cannot rebuild the storm. Lenses get 90min for a blunter reason: a single lens legitimately ran
// 46 minutes, so no threshold there can separate "hung" from "thorough" — it is a backstop against
// an agent stuck for hours, nothing finer.

// ---- re-dispatch breaker (verification only) ----
// ARMED BY THE CALLER, NOT BY A PHASE LABEL, and that distinction is the whole scope of this thing.
// What makes a dead dispatch worth suppressing is that it is dispatched THROUGH THE BOUNDED
// VERIFICATION WINDOW (VERIFY_WINDOW_AGENTS): there a slot held by a dead agent is a slot DENIED to
// a live one. `opts.phase` cannot say that — it is the key into PHASE_DEADLINE_MS, a deadline
// bucket, and three dispatches wear `phase: 'Verify'` while running nowhere near the window: the
// single haiku dedup agent (before the pool), the `<profile>-verify` checkpoint (after it), and
// anything later that reuses the bucket. Keying on the label leaked both ways — a dead one of those
// ate a window slot's worth of evidence, and a live one wrote reachability the pool never observed.
// So `verifyPool` creates a breaker and hands it to exactly the dispatches it windows; every other
// dispatch, in any phase, passes none and is neither counted nor allowed to reset anything. A lens
// is deliberately not given one: there a suppressed re-dispatch costs a whole dimension of the
// review, and the window is not the scarce thing.

export const DEFAULT_DEADLINE_MS = 1800000
/** @type {Record<string, number>} */
export const PHASE_DEADLINE_MS = { Scout: 900000, Gate: 1800000, Lenses: 5400000, Verify: 1800000, Adjudicate: 1800000, Synthesize: 1800000 }
// The CEILING on the smallest remainder a re-dispatch is allowed to be launched into — not the
// floor itself, which is derived from the budget by `retryFloorFor` below. A POLICY DECISION, not a
// measurement: nothing recorded derives it. It is set against the measured live distribution from
// the other side — live verifiers answer in tens of seconds, so against an ordinary phase budget a
// remainder under a minute is a poor bet and mostly buys a harness slot to time out in.
// That reasoning is scale-bound, and the scaling below is the admission of it: under a budget of
// 100s the floor is 50s, and a re-dispatch does then go out into a remainder this paragraph would
// have called implausible. The trade is deliberate. A floor that cannot adapt is worse, because
// against a budget shorter than itself it is true before anything has run and removes the retry
// ladder entirely, which is a silent behaviour change rather than a judged bet.
const RETRY_FLOOR_MS = 60000
// The floor is RELATIVE to the budget it guards, never a flat minute. A flat minute against a
// budget SHORTER than a minute is true before the first attempt even runs, so every agent in such a
// run loses its re-dispatch — the whole retry ladder the death breaker is calibrated against
// vanishes, and the transcript says "no wall clock left to wait in" over a budget that has barely
// been touched. `deadlineMs=30000` is a documented diagnostic setting, so this is reachable, not
// theoretical. Half the budget is the cap: it keeps the guard meaningful at every scale, since a
// remainder under half of what the first attempt had is a poor bet whatever the absolute numbers.
export const retryFloorMs = (/** @type {unknown} */ totalMs) => Math.min(RETRY_FLOOR_MS, Math.floor((Number(totalMs) > 0 ? Number(totalMs) : 0) / 2))
// SAID OUT LOUD, once, at the top of the run. This one argument replaces the WHOLE phase table,
// including the 90 minutes a lens is legitimately allowed (one measured lens ran 46). Set too low it
// kills live work by deadline, and a run full of deadline fires is indistinguishable, in the
// transcript, from the API outage this code was written for — so the mistake would be diagnosed as
// the very thing it imitates. Naming the override where a reader meets it first is the cheapest
// defence there is; the transcript is the only carrier the run's clock is ever measured from.
/** @param {number} deadlineArg  the caller's `deadlineMs`, 0 when absent @param {(message: string) => void} logLine */
export function announceDeadlineOverride(deadlineArg, logLine) {
  if (deadlineArg) {
    // BOTH DIRECTIONS. The argument replaces the table, so it lengthens as readily as it shortens, and
    // a phase given four times its budget changes what the run does just as surely — it is simply
    // slower to notice. Naming only the cuts left the other half of the override unrecorded in the one
    // place this run's clock is ever read from.
    // Sub-minute values print as seconds. Rounding a 30s override to "0min" is the same defect the
    // deadline log was fixed for, inverted — and worse here, because 30000 is exactly the documented
    // diagnostic value this warning exists to explain, so the one reader it was written for is the one
    // it would mislead.
    const m = (/** @type {number} */ v) => (v >= 60000 ? `${Math.round(v / 60000)}min` : `${Math.max(1, Math.round(v / 1000))}s`)
    const moved = (/** @type {number} */ dir) => Object.entries(PHASE_DEADLINE_MS).filter(([, v]) => (dir < 0 ? v > deadlineArg : v < deadlineArg)).map(([k, v]) => `${k} ${m(v)}→${m(deadlineArg)}`)
    const shortened = moved(-1)
    const lengthened = moved(1)
    logLine(`⏱️ deadlineMs=${deadlineArg} replaces the per-phase deadline table for every phase that does not name its own`
      + `${shortened.length ? ` — SHORTENING ${shortened.join(', ')}. A phase cut below the live distribution will fire its deadline on healthy agents, and a transcript full of deadline fires reads like an API outage.` : ''}`
      + `${lengthened.length ? ` — LENGTHENING ${lengthened.join(', ')}.` : ''}`
      // Scoped honestly: the floor is derived per dispatch, and a dispatch that names its own deadline
      // (preflight's 5 minutes) is not overridden by this argument at all, so its floor stays the full
      // minute. Stating the drop globally would hand the transcript's reader a calibration that holds
      // for most agents and not all — and a wrong calibration is read with the same confidence as a
      // right one.
      + `${deadlineArg < RETRY_FLOOR_MS * 2 ? ` NOTE: for the phases this argument governs, the re-dispatch floor drops with it to ${Math.round(Math.floor(deadlineArg / 2) / 1000)}s, so a dead agent gets a much shorter second attempt than usual; a dispatch carrying its own deadline keeps its own floor.` : ''}`)
  }
}
/** @param {{ deadlineMs?: number | undefined, phase?: string | undefined }} opts @param {number} [deadlineArg]  the caller's `deadlineMs`, 0 when absent */
export function deadlineMsFor(opts, deadlineArg = 0) {
  const explicit = Number(opts.deadlineMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return deadlineArg || (PHASE_DEADLINE_MS[/** @type {string} */ (opts.phase)] ?? DEFAULT_DEADLINE_MS)
}
