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
// API outage: 30 agents died of unavailability, one after another. The k-th consecutive death is by
// definition not a one-off, and a fresh dispatch into an unreachable API has an expected value near
// zero against the cost of a whole ladder. Suppressing the re-dispatch exactly there is the saving —
// and because nothing here looks at how long a live agent is taking, no threshold can mistake a slow
// agent for a dead one. A slow agent is not judged by this code at all.
//
// The breaker CLOSES on the first success: an outage that ends restores the retry for the next
// isolated failure without anyone resetting anything.
//
// PURITY IS THE CONTRACT, as in lib/review-waves.mjs: nothing here logs, calls an agent, or reads
// workflow state. It counts, and answers one question.

// How many consecutive deaths make the next re-dispatch not worth its wall clock. Chosen to err
// toward KEEPING the retry: two independent one-off failures in a row are plausible on a healthy
// day, three are not — and the first two deaths of any outage still pay the double price, so the
// breaker can never suppress a retry that a single stray null would have wanted. Nothing recorded
// separates 2 from 3; 3 is the conservative side of that ignorance.
export const DEATH_STREAK_TO_OPEN = 3

// A counter, shared across concurrently dispatched agents ON PURPOSE. The verification window keeps
// ~24 agents in flight, so the deaths of an outage arrive interleaved — a per-agent view would see
// one death each and never see the outage at all.
export function makeDeathBreaker(streakToOpen = DEATH_STREAK_TO_OPEN) {
  const k = Math.max(1, Number(streakToOpen) || DEATH_STREAK_TO_OPEN)
  let streak = 0
  return {
    // Record a dead first attempt and answer whether re-dispatching it is still worth the clock.
    // One call, not two, because the order matters: THIS death counts toward the streak, so the
    // k-th consecutive death is the first one that does not buy a second ladder.
    deathAllowsRedispatch() {
      streak += 1
      return streak < k
    },
    // Any live answer ends the outage as far as this counter is concerned.
    recordLive() {
      streak = 0
    },
    streak() {
      return streak
    },
    streakToOpen: k,
  }
}
