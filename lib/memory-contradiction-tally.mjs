// The memory-contradiction line of analyze-runs (realm @nick/craft, nodes #281, #282): the findings the
// review runs marked as going against an active memory record (`memoryContradictions`,
// lib/memory-contradiction.mjs), how many of them the doubt signs alone would have sent to the reviewer,
// how many went to the PR as defects, and what became of each where the store knows it — read off the
// ledger of the NEWEST later review round of the same project and branch: closed (fixed), still open, set
// aside (rejected, justified, deferred, covered). A finding without a fingerprint (adversarial-review keeps
// no round chain), a later round whose ledger lives in shards, or a ledger without its fingerprint is unknown.

/**
 * @typedef {{ runs: number, count: number, doubtSignsAlone: number, toPr: number, fixed: number, open: number,
 *   setAside: number, noLaterRound: number, unknown: number }} ContradictionTally
 * @typedef {{ kind?: unknown, name?: unknown, project?: unknown, branch?: unknown, nested?: unknown, ts?: unknown, ledger?: unknown, memoryContradictions?: unknown, [k: string]: unknown }} Rec
 */

/** @param {unknown} v @returns {number} */
const n = v => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)

/** Whether `r` is a later top-level review round of `of`'s project and branch. @param {Rec} r @param {Rec} of */
function laterRound(r, of) {
  return r.kind === 'workflow' && r.name === 'review' && !r.nested && Boolean(of.branch) && r.project === of.project && r.branch === of.branch && String(r.ts) > String(of.ts)
}

/** The fate of one finding in the later round's ledger. @param {string} fp @param {Rec | undefined} later @returns {'fixed' | 'open' | 'setAside' | 'noLaterRound' | 'unknown'} */
export function fateOf(fp, later) {
  if (!later) return fp ? 'noLaterRound' : 'unknown'
  if (!fp || !Array.isArray(later.ledger)) return 'unknown'
  const row = /** @type {unknown[]} */ (later.ledger).find(e => e && typeof e === 'object' && /** @type {Record<string, unknown>} */ (e)['fp'] === fp)
  const disposition = row ? /** @type {Record<string, unknown>} */ (row)['disposition'] : undefined
  if (disposition === 'closed') return 'fixed'
  if (disposition === 'open') return 'open'
  return typeof disposition === 'string' ? 'setAside' : 'unknown'
}

/** One run's findings into the tally, each with its fate. @param {ContradictionTally} t @param {Record<string, unknown>} m @param {Rec | undefined} later */
function tallyRun(t, m, later) {
  t.runs++
  t.count += n(m['count'])
  t.doubtSignsAlone += n(m['doubtSignsAlone'])
  for (const f of Array.isArray(m['findings']) ? m['findings'] : []) {
    const item = /** @type {Record<string, unknown>} */ (f && typeof f === 'object' ? f : {})
    if (item['toPr'] === true) t.toPr++
    t[fateOf(typeof item['fp'] === 'string' ? item['fp'] : '', later)]++
  }
}

/** The tally over every record of the store. @param {Rec[]} records @returns {ContradictionTally} */
export function tallyContradictions(records) {
  /** @type {ContradictionTally} */
  const t = { runs: 0, count: 0, doubtSignsAlone: 0, toPr: 0, fixed: 0, open: 0, setAside: 0, noLaterRound: 0, unknown: 0 }
  for (const r of records) {
    const m = r.memoryContradictions
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const later = records.filter(x => laterRound(x, r)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0]
    tallyRun(t, /** @type {Record<string, unknown>} */ (m), later)
  }
  return t
}

/** The line, under its heading. @param {ContradictionTally} t @returns {string[]} */
export function renderContradictionLines(t) {
  const L = ['## MEMORY CONTRADICTIONS — findings whose code goes against an active memory record (sorted as defects)']
  if (!t.runs) return [...L, '- NOT MEASURED — no run carries `memoryContradictions`']
  return [...L, `- ${t.count} finding(s) in ${t.runs} run(s) · ${t.doubtSignsAlone} the doubt signs alone would have sent to the reviewer · ${t.toPr} sent to the PR as defects`
    + ` · later rounds: ${t.fixed} fixed · ${t.open} still open · ${t.setAside} set aside · ${t.noLaterRound} no later round · ${t.unknown} unknown`]
}
