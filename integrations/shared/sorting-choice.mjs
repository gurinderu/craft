// The outcome of the sorting before publication, on the run store (realm @nick/craft, node #281): a review
// run with `comment` records how many findings it posted as defects and which it held back as doubtful
// (`sorting`, integrations/claude-code/src/review.js); the reviewer's later choice for each doubtful one — asked the author, posted
// as a defect, not posted — is appended to the SAME run's record by `craft runs sorting-choice` (cli/crates/craft-store/src/sorting.rs), the
// one writer of the store (node #39); `craft runs retro` tallies how the doubtful ones ended (the precision of
// the sorting, node #270).

/** @typedef {import('./run-record.mjs').RunRecord} RunRecord */
/**
 * A doubtful finding as the record keeps it (the binary's sorting, cli/crates/craft-review/src/publish/sort.rs).
 * @typedef {{ n: number, severity?: string, title: string, file: string, line: number, why?: string, fix?: string, source?: string, toolRule?: string, outsideDiff?: boolean }} SortedFinding
 */

/** The record's `sorting` object, or null. @param {RunRecord} r @returns {Record<string, unknown> | null} */
export function sortingOf(r) {
  const s = r['sorting']
  return s && typeof s === 'object' && !Array.isArray(s) ? /** @type {Record<string, unknown>} */ (s) : null
}

/** The doubtful findings a record lists. @param {RunRecord} r @returns {SortedFinding[]} */
export function sortedFindings(r) {
  const list = sortingOf(r)?.['findings']
  return Array.isArray(list) ? /** @type {SortedFinding[]} */ (list.filter(x => x && typeof x === 'object')) : []
}

/**
 * A doubtful finding's identity across two sortings of one run: its file, line and title. A stored finding is
 * read JSON, so each field is read as it may be. @param {{ file?: unknown, line?: unknown, title?: unknown }} f
 */
const findingKey = f => JSON.stringify([String(f.file ?? ''), Number(f.line) || 0, String(f.title ?? '')])

/**
 * The record with a publication after the fact (`craft review comment`; realm @nick/craft, node #270) written in: its
 * sorting, the findings going against memory and what was posted, each replacing the record's own. The reviewer's
 * choices already recorded follow their finding — by file, line and title — to its number in the new sorting; one
 * whose finding the new sorting no longer lists is dropped and named in `dropped` (`<n> (<title> @ <file>:<line>):
 * <choice>`).
 * @param {RunRecord} record @param {Record<string, unknown>} kept  `sorting`, `memoryContradictions`, `prComments`
 * @returns {{ record: RunRecord, dropped: string[] }}
 */
export function applyPublication(record, kept) {
  const next = kept['sorting'] && typeof kept['sorting'] === 'object' ? /** @type {Record<string, unknown>} */ (kept['sorting']) : null
  const { choices, dropped } = carriedChoices(record, next)
  const sorting = next && choices ? { ...next, choices } : next
  return { record: { ...record, sorting, memoryContradictions: kept['memoryContradictions'] ?? null, prComments: kept['prComments'] ?? null }, dropped }
}

/** A dropped choice as it is named. @param {string} n @param {SortedFinding | undefined} f @param {unknown} c */
const droppedChoice = (n, f, c) => `${n} (${f ? `${f.title} @ ${f.file}:${f.line}` : 'no such finding'}): ${String(/** @type {any} */ (c)?.choice ?? '')}`

/**
 * The record's choices renumbered for the `next` sorting, null when it has none, and those whose finding is gone.
 * @param {RunRecord} record @param {Record<string, unknown> | null} next
 * @returns {{ choices: Record<string, unknown> | null, dropped: string[] }}
 */
function carriedChoices(record, next) {
  const old = sortingOf(record)?.['choices']
  if (!old || typeof old !== 'object') return { choices: null, dropped: [] }
  const before = new Map(sortedFindings(record).map(f => [String(f.n), f]))
  const after = new Map(sortedFindings({ sorting: next }).map(f => [findingKey(f), String(f.n)]))
  /** @type {Record<string, unknown>} */
  const choices = {}
  /** @type {string[]} */
  const dropped = []
  for (const [n, c] of Object.entries(old)) {
    const f = before.get(n)
    const to = f && after.get(findingKey(f))
    if (to) choices[to] = c
    else dropped.push(droppedChoice(n, f, c))
  }
  return { choices: Object.keys(choices).length ? choices : null, dropped }
}
