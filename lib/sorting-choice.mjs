// The outcome of the sorting before publication, on the run store (realm @nick/craft, node #281): a review
// run with `comment` records how many findings it posted as defects and which it held back as doubtful
// (`sorting`, src/review.js); the reviewer's later choice for each doubtful one — asked the author, posted
// as a defect, not posted — is appended to the SAME run's record by `craft-log-run sorting-choice`, the
// one writer of the store (node #39); analyze-runs tallies how the doubtful ones ended (the precision of
// the sorting, node #270).
import fs from 'node:fs'
import path from 'node:path'
import { parseJsonObject } from './json-object.mjs'

/** @typedef {import('./run-record.mjs').RunRecord} RunRecord */
/** @typedef {{ n: number, title: string, file: string, line: number }} SortedFinding */

export const SORTING_CHOICES = ['question', 'defect', 'dropped']

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
 * The record with the reviewer's `choice` for doubtful finding `n` set (a later choice for the same finding
 * replaces the earlier one), and that finding; a string: why it cannot be recorded.
 * @param {RunRecord} record @param {number} n @param {string} choice @param {Date} now
 * @returns {{ record: RunRecord, finding: SortedFinding } | string}
 */
export function applySortingChoice(record, n, choice, now) {
  if (!SORTING_CHOICES.includes(choice)) return `--choice must be one of ${SORTING_CHOICES.join(', ')}, got ${JSON.stringify(choice)}`
  const sorting = sortingOf(record)
  if (!sorting) return 'the record carries no sorting (a review run without comment, or an older engine)'
  const finding = sortedFindings(record).find(f => Number(f.n) === n)
  if (!finding) return `the record lists no doubtful finding numbered ${n}`
  const prior = sorting['choices'] && typeof sorting['choices'] === 'object' ? /** @type {Record<string, unknown>} */ (sorting['choices']) : {}
  const choices = { ...prior, [String(n)]: { choice, at: now.toISOString() } }
  return { record: { ...record, sorting: { ...sorting, choices } }, finding }
}

/**
 * The newest review record in `store` of `project` that carries a sorting with doubtful findings, or null.
 * Detail files are named `<ts>-<kind>-<name>.json`, so the name orders them by time.
 * @param {string} store @param {string} project @returns {string | null}
 */
export function latestSortedRecord(store, project) {
  let names
  try { names = fs.readdirSync(store) } catch { return null }
  for (const name of names.filter(x => /-review\.json$/.test(x)).sort().reverse()) {
    const file = path.join(store, name)
    /** @type {RunRecord} */
    let r
    try { r = parseJsonObject(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (r.project === project && sortedFindings(r).length) return file
  }
  return null
}

/** @typedef {{ runs: number, doubtful: number, defect: number, question: number, dropped: number, posted: number }} SortingTally */

/** @returns {SortingTally} */
export function newSortingTally() {
  return { runs: 0, doubtful: 0, defect: 0, question: 0, dropped: 0, posted: 0 }
}

/** @param {unknown} v @returns {number} */
const count = v => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0)

/** Adds one record's sorting, when it has one. @param {SortingTally} t @param {RunRecord} r @returns {void} */
export function tallySorting(t, r) {
  const s = sortingOf(r)
  if (!s) return
  t.runs++
  t.posted += count(s['defect'])
  t.doubtful += count(s['doubtful'])
  const choices = s['choices'] && typeof s['choices'] === 'object' ? Object.values(/** @type {Record<string, unknown>} */ (s['choices'])) : []
  for (const c of choices) {
    const choice = c && typeof c === 'object' ? /** @type {Record<string, unknown>} */ (c)['choice'] : undefined
    if (choice === 'defect' || choice === 'question' || choice === 'dropped') t[choice]++
  }
}

/** The section's lines. @param {SortingTally} t @returns {string[]} */
export function renderSortingSection(t) {
  const L = ['## SORTING — how the doubtful findings held back from the PR ended']
  if (!t.runs) return [...L, '- NOT MEASURED — no run carries `sorting` (a review posting to a PR with comment)']
  const decided = t.defect + t.question + t.dropped
  /** @param {number} n */
  const pct = n => (t.doubtful ? ` (${Math.round((n / t.doubtful) * 100)}%)` : '')
  L.push(`- ${t.runs} run(s) · ${t.posted} posted as defects at once · ${t.doubtful} held back as doubtful`)
  L.push(`- of the doubtful: ${t.defect} posted as defect${pct(t.defect)} · ${t.question} asked the author${pct(t.question)} · ${t.dropped} not posted${pct(t.dropped)} · ${Math.max(0, t.doubtful - decided)} still undecided`)
  return L
}
