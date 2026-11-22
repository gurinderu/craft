// The Workflow sandbox's `budget.spent()` counts the whole session, not one run: records filed one after another in a
// session carried a rising figure (9.73M, then 9.81M) while each run's own transcripts summed 108k and 60k output
// tokens. An engine reads its own share as the difference from what was spent when it started.

/**
 * The run's own view of the sandbox budget: `spent()` counts from this call on, never below zero.
 * @param {{ total: number | null, spent: () => number, remaining: () => number }} sandbox
 * @returns {{ total: number | null, spent: () => number, remaining: () => number }}
 */
export function runBudget(sandbox) {
  const start = sandbox.spent()
  return { total: sandbox.total, spent: () => Math.max(0, sandbox.spent() - start), remaining: () => sandbox.remaining() }
}
