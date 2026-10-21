// The MEMORY section of analyze-runs: did the runs recall, from which backend, and why not. Read off
// the record's `memory` field (lib/memory-recall.mjs memoryRecord; realm @nick/craft, node #40). A run
// without the field (an older record, an engine that does not recall) is counted apart, its cause not
// asserted — silence there is not "nothing recalled".

// A review nested under rust-audit (source `launcher`) applies the audit's one recall: it is counted
// apart, never as a run that applied memory nor under a backend, so one recall reads as one. The project
// rules recalled count with the records (at the recall, so once); the findings a rule covered count on
// every run that applied rules, a nested review included: each covers its own (realm @nick/craft, node #273).
/**
 * @typedef {{ runs: number, carrying: number, recalled: number, passedOnly: number, nested: number, none: number,
 *   records: number, questions: number, rules: number, covered: number, byBackend: Record<string, number>, noneWhy: Record<string, number> }} MemoryTally
 */

/** @returns {MemoryTally} */
export function newMemoryTally() {
  return { runs: 0, carrying: 0, recalled: 0, passedOnly: 0, nested: 0, none: 0, records: 0, questions: 0, rules: 0, covered: 0, byBackend: {}, noneWhy: {} }
}

/** @param {unknown} v @returns {number} */
const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** @param {unknown} v @param {string} fallback @returns {string} */
const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback)

// The reason class of a none: `why` is free prose (the agent's own words, an error, a budget figure),
// so ranking it whole gives every run its own row. The engines' own reasons open with fixed words;
// anything else is the recall agent answering with nothing, classed by the backend it named.
/** @type {Array<[string, string]>} */
const NONE_CLASSES = [
  ['the recall agent died', 'the recall agent died or returned no list'],
  ['the recall agent did not run', 'the recall agent did not run'],
  ['recall did not run — budget below the floor', 'budget below the floor'],
  ['pinned backend unavailable', 'pinned backend unavailable'],
]

/** @param {string} why @param {string} backend @returns {string} */
function noneClass(why, backend) {
  if (why.startsWith('not recalled — ')) return why.split(';')[0] ?? why
  const known = NONE_CLASSES.find(([lead]) => why.startsWith(lead))
  return known ? known[1] : `recall found nothing in ${backend}`
}

/** @param {Record<string, number>} counts @param {string} key @returns {void} */
const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1 }

/**
 * Adds one run's record to the tally.
 * @param {MemoryTally} t @param {{ memory?: unknown }} r @returns {void}
 */
export function tallyMemory(t, r) {
  t.runs++
  const m = r.memory
  if (!m || typeof m !== 'object' || Array.isArray(m)) return
  const o = /** @type {Record<string, unknown>} */ (m)
  t.carrying++
  t.covered += count(o['covered'])
  const source = o['source']
  if (source === 'launcher') { t.nested++; return }
  if (source === 'recalled') {
    t.recalled++
    t.records += count(o['count'])
    t.questions += count(o['questions'])
    t.rules += count(o['rules'])
    bump(t.byBackend, text(o['backend'], 'unnamed'))
    return
  }
  t.none++
  // Recall did not run or found nothing, yet the launcher's own records were applied.
  if (count(o['passed'])) t.passedOnly++
  bump(t.noneWhy, noneClass(text(o['why'], 'no reason recorded'), text(o['backend'], 'an unnamed backend')))
}

/** @param {Record<string, number>} counts @returns {Array<[string, number]>} */
const ranked = counts => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

/**
 * The section's lines.
 * @param {MemoryTally} t @returns {string[]}
 */
export function renderMemorySection(t) {
  const L = ['## MEMORY — what the review recalled before judging']
  const silent = t.runs - t.carrying
  if (!t.carrying) {
    L.push(`- NOT MEASURED — none of the ${t.runs} run(s) carried \`memory\`, so this is not "nothing recalled"`)
    return L
  }
  const nested = t.nested ? ` · ${t.nested} nested under an audit, its one recall counted at the audit` : ''
  L.push(`- ${t.carrying} run(s) carry the field${silent ? ` (${silent} without it, excluded)` : ''} · ${t.recalled} recalled · ${t.none} none (${t.passedOnly} of them applied the launcher's records)${nested} · ${t.records} record(s) recalled, ${t.questions} of them open questions`)
  if (t.rules || t.covered) L.push(`- project rules: ${t.rules} recalled · ${t.covered} finding(s) covered by one, out of the verdict`)
  for (const [backend, n] of ranked(t.byBackend).slice(0, 10)) L.push(`- ${n}× from ${backend}`)
  for (const [why, n] of ranked(t.noneWhy).slice(0, 10)) L.push(`- ${n}× none — ${why}`)
  return L
}
