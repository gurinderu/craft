// ================= Re-dispatch economics on a bad day =================
// Measured on one large review run (Rust profile, 6.4h wall clock, 179 agents, 79905 agent-seconds):
// 46 dispatched verifiers produced NO verdict at all and cost 37050 agent-seconds — 58% of the
// verification pass and 46.4% of the whole run. Their transcripts are four lines each, the last one
// an interruption. They computed nothing and returned nothing.
//
// WHERE THOSE SECONDS GO, exactly. Each dead dispatch sat between ~500s and ~660s: `agent()` does
// not throw when the API is unreachable, it resolves `null` after the harness has exhausted its own
// internal retry ladder. That is entirely below the Verify per-agent deadline (30min), so the
// deadline never fired and never could — it is not what held the slot. What doubled the bill is the
// one quiet re-dispatch in `ragent`: a second full ladder, paid inside the same verification window
// slot, while the window bounds DISPATCH and not occupancy, so every one of those seconds is a slot a
// live verifier could not have.
//
// So the recoverable half is the second ladder, and only it. Lowering the deadline cannot reach this
// cost — a death resolves faster than any threshold a legitimately slow verifier could survive
// (verification agents were measured up to 811s, lenses to 46 minutes).
//
// THE SIGNAL IS OTHER AGENTS' DEATHS, NEVER THIS AGENT'S DURATION. The re-dispatch exists against a
// ONE-OFF failure, and on a one-off it is worth its wall clock. What made that run expensive was an
// API outage. A fresh dispatch into an unreachable API has an expected value near zero against the
// cost of a whole ladder, so suppressing the re-dispatch exactly there is the saving — and because
// nothing here looks at how long a live agent is taking, no threshold can mistake a slow agent for a
// dead one. A slow agent is not judged by this code at all.
//
// WHAT THE SIGNAL IS, AND WHY IT IS NOT A CONSECUTIVE STREAK. The first shape of this breaker asked
// for k deaths IN A ROW, and that signal cannot see the failure it was built for. The measured run
// was a PARTIAL outage — 46 deaths among 179 agents — and time works against a run of deaths: a dead
// dispatch resolves in 500-660s while a live verifier answers in tens of seconds, so in a partial
// outage live answers land BETWEEN the deaths by construction. A consecutive streak is therefore
// reset by the very interleaving that a partial outage produces, and the saving would have been real
// only in an almost total one. Nothing recorded says those 46 deaths arrived in runs of three.
//
// So the signal is a FRACTION OVER A SLIDING WINDOW of the last observed dispatch outcomes: the
// re-dispatch stops being bought once at least half of the last six verification dispatches returned
// nothing. Interleaving no longer hides an outage, and the window is also the decay — a phase that
// recovers slides its deaths out after four live answers and gets its re-dispatch back without
// anyone resetting anything.
//
// PURITY IS THE CONTRACT, as in lib/review-waves.mjs: nothing here logs, calls an agent, or reads
// workflow state. It counts, and answers one question.

// The window is six observed outcomes and the breaker opens at three deaths inside it. Chosen to err
// toward KEEPING the retry: one or two deaths out of six are plausible on a healthy day (and the
// first two deaths of any outage still pay the double price, so the breaker can never suppress a
// retry that a single stray null would have wanted), while half of the recent dispatches returning
// nothing is not a day on which a second ladder is worth its wall clock. Nothing recorded separates
// 2 from 3; 3 is the conservative side of that ignorance.
export const DEATH_WINDOW_DISPATCHES = 6
export const DEATHS_IN_WINDOW_TO_OPEN = 3

export function positiveInt(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

// A counter, shared across the concurrently dispatched agents OF ONE verification pass on purpose.
// The verification window keeps ~24 agents in flight, so the deaths of an outage arrive interleaved
// — a per-agent view would see one death each and never see the outage at all. It is an INSTANCE,
// not a module-level variable: a pass gets its own, so a window left half-full by one profile's
// verification cannot decide anything for the next profile's, whose reachability it never observed.
export function makeDeathBreaker(opts = {}) {
  const windowLen = positiveInt(opts.window, DEATH_WINDOW_DISPATCHES)
  const toOpen = Math.min(windowLen, positiveInt(opts.toOpen, Math.min(windowLen, DEATHS_IN_WINDOW_TO_OPEN)))
  // The last `windowLen` observed outcomes, oldest first; true = the dispatch returned nothing.
  const recent = []
  const observe = isDeath => {
    recent.push(isDeath)
    while (recent.length > windowLen) recent.shift()
  }
  const deaths = () => recent.reduce((n, isDeath) => n + (isDeath ? 1 : 0), 0)
  return {
    // Record a dead first attempt and answer whether re-dispatching it is still worth the clock.
    // One call, not two, because the order matters: THIS death counts toward the window, so the
    // death that fills it is the first one that does not buy a second ladder.
    deathAllowsRedispatch() {
      observe(true)
      return deaths() < toOpen
    },
    // A live answer is evidence the API is reachable, and it enters the window as one observation —
    // it does not erase the outage behind it. Recovery is what slides the deaths out.
    recordLive() {
      observe(false)
    },
    // What the log needs to say WHICH dispatch this is, honestly: deaths out of outcomes observed.
    deaths,
    observed() {
      return recent.length
    },
    windowLen,
    toOpen,
  }
}
