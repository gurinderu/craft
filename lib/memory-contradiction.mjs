// A finding that shows the code going against an active project-memory record — a decision, a deferred
// question or a project rule (realm @nick/craft, nodes #196, #273) — is a defect, stronger than the intent
// doubt signs (node #282), though not than "not confirmed" (node #423). The memory judges say so beside
// their own verdict (`violates`; lib/prior-decision-match.mjs, lib/project-rule-judge.mjs): no further agent
// is asked. The finding stays marked `memoryContradicts` with the record's id (lib/finding-sort.mjs reads the mark);
// the run record's count of such findings is the craft binary's now, and analyze-runs reads it
// (lib/memory-contradiction-tally.mjs). Imported by triage-findings through lib/prior-decision-apply.mjs.
import { contradictionOf } from './finding-sort.mjs'
import { clipLine } from './prior-decision-match.mjs'

/**
 * @typedef {import('./finding-sort.mjs').SortableFinding} SortableFinding
 */

/**
 * The finding marked with the record the judge says its code goes against; unchanged when there is none or
 * it is marked already (the decisions are judged before the rules, and the first mark stands).
 * @template {SortableFinding} F @param {F} f @param {{ d: { id: string, kind: string }, why: string } | undefined} c @returns {F}
 */
export function markContradicting(f, c) {
  if (!c || contradictionOf(f)) return f
  return { ...f, memoryContradicts: { id: c.d.id, kind: c.d.kind, why: clipLine(c.why) } }
}
