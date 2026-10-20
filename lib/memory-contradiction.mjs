// A finding that shows the code going against an active project-memory record — a decision, a deferred
// question or a project rule (realm @nick/craft, nodes #196, #273) — is a certain defect, stronger than the
// doubt signs (node #282). The memory judges say so beside their own verdict (`violates`;
// lib/prior-decision-match.mjs, lib/project-rule-judge.mjs): no further agent is asked. The finding stays in
// the verdict marked `memoryContradicts` with the record's id, the sorting sends it to the defects
// (lib/finding-sort.mjs), and the run record counts such findings and how many the doubt signs alone would
// have sent to the reviewer (node #281); analyze-runs reads that count (lib/memory-contradiction-tally.mjs).
// Inlined into src/review.js and src/adversarial-review.js after finding-sort.mjs.
import { contradictionOf, doubtReasons } from './finding-sort.mjs'
import { clipLine, findingLine } from './prior-decision-match.mjs'

/**
 * @typedef {import('./finding-sort.mjs').SortableFinding} SortableFinding
 * @typedef {import('./diff-lines.mjs').ChangedLines} ChangedLines
 * @typedef {{ fp: string, record: string, kind: string, severity: string, title: string, file: string, line: number, doubtSigns: string[], toPr: boolean }} ContradictionItem
 * @typedef {{ count: number, doubtSignsAlone: number, inDiffJudged: boolean, findings: ContradictionItem[] }} ContradictionRecord
 */

export const CONTRADICTION_HEADING = '## Contradicts project memory — a defect, whatever the doubt signs say'

/**
 * The finding marked with the record the judge says its code goes against; unchanged when there is none or
 * it is marked already (the decisions are judged before the rules, and the first mark stands).
 * @template {SortableFinding} F @param {F} f @param {{ d: { id: string, kind: string }, why: string } | undefined} c @returns {F}
 */
export function markContradicting(f, c) {
  if (!c || contradictionOf(f)) return f
  return { ...f, memoryContradicts: { id: c.d.id, kind: c.d.kind, why: clipLine(c.why) } }
}

/**
 * The run record's count of the findings going against memory: each with the record, the doubt signs that
 * would have sent it to the reviewer without the mark, and whether it went to the PR as a defect.
 * `changed` null: the outside-the-diff sign was not told (`inDiffJudged` false).
 * @param {SortableFinding[]} findings the verdict's findings, each with its tier @param {ChangedLines | null} changed
 * @param {(f: SortableFinding) => string} fpOf @param {(f: SortableFinding) => boolean} toPr
 * @returns {ContradictionRecord}
 */
export function contradictionRecord(findings, changed, fpOf, toPr) {
  /** @type {ContradictionItem[]} */
  const items = []
  for (const f of findings) {
    const c = contradictionOf(f)
    if (!c) continue
    items.push({
      fp: fpOf(f), record: c.id, kind: c.kind, severity: String(f.severity ?? ''), title: clipLine(f.title), file: String(f.file ?? ''),
      line: findingLine(f), doubtSigns: doubtReasons(f, changed), toPr: toPr(f),
    })
  }
  return { count: items.length, doubtSignsAlone: items.filter(x => x.doubtSigns.length).length, inDiffJudged: changed != null, findings: items }
}

/**
 * The report section naming each finding going against memory, with the record and the judge's why; ''
 * when there is none. @param {SortableFinding[]} findings @returns {string}
 */
export function contradictionSection(findings) {
  const lines = findings.flatMap(f => {
    const c = contradictionOf(f)
    return c ? [`- ${String(f.severity ?? '?')} · \`${String(f.file || '?')}:${findingLine(f)}\` · ${String(f.title ?? '')} · goes against ${c.kind || 'record'} ${c.id}: ${c.why}`] : []
  })
  return lines.length ? `\n\n${CONTRADICTION_HEADING}\n${lines.join('\n')}\n` : ''
}
