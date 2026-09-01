// ================= Verification wave bounding =================
// The per-agent deadline is measured from DISPATCH, not from the moment an agent starts running.
// So the depth of the dispatch queue is part of every deadline: hand ~130 verification thunks to a
// single parallel() and agents wait a quarter of an hour for a slot, the deadline fires on that
// waiting, and the retry re-dispatches work that was merely in line — which makes the queue deeper
// still. One measured run turned 23 findings into 172 verification agents that way.
//
// The cure is to bound how many AGENTS one wave puts in flight. A thunk is not an agent: a batch
// thunk spawns exactly one, but an individual High spawns its opening pair and, on a split, the
// rest of the panel. Weighing a wave by thunk count is precisely the arithmetic error that buried
// the queue.
//
// These helpers live here, outside the workflow, for the same reason lib/review-adjudicate.mjs
// does: workflows/review.js cannot be imported, so anything declared there can be tested only by
// eval'ing a copy of its text. Here they are a real module — imported by real tests, linted, and
// pasted back into the workflow verbatim through a `craft-inline` fenced region.
//
// PURITY IS THE CONTRACT. Nothing here logs, reads workflow state, or calls an agent.

// How many AGENTS one verification wave may put in flight. Chosen so the queue term of the Verify
// deadline stays small: ~24 agents over an execution p90 of ~360s is well under 15min of waiting,
// which is what makes a 30min dispatch-clock deadline mean "stuck" rather than "popular".
export const VERIFY_WAVE_AGENTS = 24

// Worst-case agent count for one verification thunk, so a wave can only ever come in under budget,
// never over. A batch thunk is one agent; a High/Critical opens with a cull + the authoritative
// vote and, if they split, buys the remaining n1-1 culls — 1 + max(1, verifyVotes) in total.
export function verifyWeight(f, plan) {
  const isHigh = f.severity === 'Critical' || f.severity === 'High'
  return isHigh ? 1 + Math.max(1, Number(plan?.verifyVotes) || 1) : 1
}

// Split an ordered list of {run, weight} entries into waves whose weights sum to at most
// `maxWeight`, PRESERVING ORDER. Order is the invariant that matters: the caller concatenates the
// waves' results and slices them back apart positionally, so any reordering here would hand one
// finding's verdict to another finding. An entry heavier than the whole budget forms its own wave
// rather than being dropped.
export function weightedWaves(entries, maxWeight) {
  const cap = Math.max(1, Number(maxWeight) || 1)
  const waves = []
  let cur = []
  let w = 0
  for (const e of entries) {
    const ew = Math.max(1, Number(e.weight) || 1)
    if (cur.length && w + ew > cap) { waves.push(cur); cur = []; w = 0 }
    cur.push(e)
    w += ew
  }
  if (cur.length) waves.push(cur)
  return waves
}
