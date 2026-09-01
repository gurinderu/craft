// ================= Verification dispatch bounding =================
// The per-agent deadline is measured from DISPATCH, not from the moment an agent starts running.
// So the depth of the dispatch queue is part of every deadline: hand ~130 verification thunks to a
// single parallel() and agents wait a quarter of an hour for a slot, the deadline fires on that
// waiting, and the retry re-dispatches work that was merely in line — which makes the queue deeper
// still. One measured run turned 23 findings into 172 verification agents that way.
//
// The cure is to bound how many AGENTS verification keeps in flight. A thunk is not an agent: a batch
// thunk spawns exactly one, but an individual High spawns its opening pair and, on a split, the
// rest of the panel. Weighing the window by thunk count is precisely the arithmetic error that buried
// the queue.
//
// These helpers live here, outside the workflow, for the same reason lib/review-adjudicate.mjs
// does: workflows/review.js cannot be imported, so anything declared there can be tested only by
// eval'ing a copy of its text. Here they are a real module — imported by real tests, linted, and
// pasted back into the workflow verbatim through a `craft-inline` fenced region.
//
// PURITY IS THE CONTRACT. Nothing here logs, reads workflow state, or calls an agent — weightedWindow
// takes its runner as an argument for exactly that reason.

// How many AGENTS verification keeps in flight at once. Chosen so the queue term of the Verify
// deadline stays small: ~24 agents over an execution p90 of ~360s is well under 15min of waiting,
// which is what makes a 30min dispatch-clock deadline mean "stuck" rather than "popular".
//
// It bounds DISPATCH, not occupancy: ragent re-dispatches once after a deadline, and the abandoned
// agent keeps its harness concurrency slot until it is reaped, so a window can transiently sit at up
// to twice this number. That doubling costs a 30min deadline first, so it cannot recreate the
// unbounded storm — but it is a real ceiling of ~48, not ~24.
export const VERIFY_WAVE_AGENTS = 24

// Worst-case agent count for one verification thunk, so the window can only ever come in under budget,
// never over. A batch thunk is one agent; a High/Critical opens with a cull + the authoritative
// vote and, if they split, buys the remaining n1-1 culls — 1 + max(1, verifyVotes) in total.
export function verifyWeight(f, plan) {
  const isHigh = f.severity === 'Critical' || f.severity === 'High'
  return isHigh ? 1 + Math.max(1, Number(plan?.verifyVotes) || 1) : 1
}

// Run an ordered list of {run, weight} entries keeping at most `maxWeight` weight in flight, with
// NO barrier: as each entry settles, the next one that fits is dispatched immediately. Waves (a
// barrier per batch) gave the same in-flight cap but made every batch wait for its slowest member —
// ~9 barriers on a large run, against verification agents measured up to 811s.
//
// ORDER IS THE INVARIANT. The caller concatenates the results and slices them apart positionally,
// so a verdict must land at its entry's index. Entries settle out of order here, so results are
// assigned BY INDEX (`out[i]`), never by arrival. The returned array always has exactly
// `entries.length` slots, in input order.
//
// `runOne(entry.run, i)` is injected so this stays pure and testable — the workflow passes a runner
// that hands the thunk to the sandbox's parallel(), which turns a throwing thunk into null. Anything
// runOne rejects with is recorded as null rather than tearing down the whole dispatch.
//
// An entry heavier than the whole budget still runs: it waits for an empty window, then goes alone.
export async function weightedWindow(entries, maxWeight, runOne) {
  const cap = Math.max(1, Number(maxWeight) || 1)
  const out = new Array(entries.length).fill(null)
  let next = 0
  let inflight = 0
  await new Promise(resolve => {
    const pump = () => {
      while (next < entries.length) {
        const w = Math.max(1, Number(entries[next].weight) || 1)
        // `inflight > 0 &&`: an over-budget entry is never starved, it just never shares the window.
        if (inflight > 0 && inflight + w > cap) break
        const i = next++
        inflight += w
        Promise.resolve()
          .then(() => runOne(entries[i].run, i))
          .then(v => { out[i] = v ?? null }, () => { out[i] = null })
          .then(() => { inflight -= w; pump() })
      }
      if (next >= entries.length && inflight === 0) resolve()
    }
    pump()
  })
  return out
}
