// The Workflow sandbox's `budget.spent()` is one pool for the whole turn — the main loop and every workflow running
// at the same time draw from it — so records filed one after another in a session carried a rising figure (9.73M,
// then 9.81M) while each run's own transcripts summed 108k and 60k output tokens. No reading of it is one run's own:
// an engine records only the pool's growth while it ran, an indicative figure; a run's real cost is the `cost` that
// `craft runs enrich-cost` folds in from its transcripts. A record carrying that growth says so with
// `outputTokensScope: 'turn-delta'` (TURN_DELTA, integrations/shared/run-record.mjs); one without it is
// an older record, whose figure is the session's running total.

/**
 * The pool's growth since this call: `spent()` is null with no sandbox budget, and null — said once through `say` — should
 * a reading fall below its value here. Only `spent()` is exposed: the pool's total and what remains of it are the
 * turn's, not the run's.
 * @param {{ spent: () => number } | undefined} sandbox @param {(line: string) => void} [say]
 * @returns {{ spent: () => number | null }}
 */
export function runBudget(sandbox, say = () => {}) {
  if (!sandbox) return { spent: () => null }
  const start = sandbox.spent()
  let told = false
  return {
    spent: () => {
      const now = sandbox.spent()
      if (now >= start) return now - start
      if (!told) say(`⚠️ budget.spent() read ${String(now)}, below ${String(start)} at the run's start: a reading below it gives no figure (null)`)
      told = true
      return null
    },
  }
}
