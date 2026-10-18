// The MEMORY section of analyze-runs: did the runs recall, from which backend, and why not. Read off
// the record's `memory` field (lib/memory-recall.mjs memoryRecord; realm @nick/craft, node #40). A run
// without the field (an older record, an engine that does not recall) is counted apart, its cause not
// asserted — silence there is not "nothing recalled".

/**
 * @typedef {{ runs: number, carrying: number, recalled: number, launcher: number, none: number,
 *   records: number, questions: number, byBackend: Record<string, number>, noneWhy: Record<string, number> }} MemoryTally
 */

/** @returns {MemoryTally} */
export function newMemoryTally() {
  return { runs: 0, carrying: 0, recalled: 0, launcher: 0, none: 0, records: 0, questions: 0, byBackend: {}, noneWhy: {} }
}

/** @param {unknown} v @returns {number} */
const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** @param {unknown} v @param {string} fallback @returns {string} */
const text = (v, fallback) => (typeof v === 'string' && v ? v : fallback)

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
  const source = o['source']
  if (source === 'recalled' || source === 'launcher') {
    t[source]++
    t.records += count(o['count'])
    t.questions += count(o['questions'])
    bump(t.byBackend, text(o['backend'], source === 'launcher' ? 'the launching audit' : 'unnamed'))
    return
  }
  t.none++
  bump(t.noneWhy, text(o['why'], 'no reason recorded'))
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
  const applied = t.recalled + t.launcher
  L.push(`- ${t.carrying} run(s) carry the field${silent ? ` (${silent} without it, excluded)` : ''} · ${applied} applied memory (${t.recalled} recalled, ${t.launcher} from the launching audit) · ${t.none} none · ${t.records} record(s) applied, ${t.questions} of them open questions`)
  for (const [backend, n] of ranked(t.byBackend)) L.push(`- ${n}× from ${backend}`)
  for (const [why, n] of ranked(t.noneWhy).slice(0, 10)) L.push(`- ${n}× none — ${why}`)
  return L
}
