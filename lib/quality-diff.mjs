// The comparisons behind the quality delta (realm @nick/craft, #147): which functions rose between base
// and head, which identifiers appeared or went, and one table row of base, head and Δ. Rendered by
// lib/quality-render.mjs.

/** @typedef {import('./quality-tally.mjs').Tally} Tally */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
/** @typedef {{ name: string, file: string, line: number, base: number | null, head: number, delta: number }} Riser */

const TOP = 10

/**
 * Functions whose value rose, or that are new above the threshold (the gate's bar), largest rise first.
 * @param {Tally} base @param {Tally} head @param {number} threshold @param {number} [limit]
 * @returns {Riser[]}
 */
export function risers(base, head, threshold, limit = TOP) {
  const before = new Map(base.functions.map(f => [f.key, f.value]))
  /** @type {Riser[]} */
  const out = []
  for (const f of head.functions) {
    const b = before.get(f.key)
    if (b === undefined ? f.value > threshold : f.value > b) {
      out.push({ name: f.name, file: f.file, line: f.line, base: b ?? null, head: f.value, delta: f.value - (b ?? 0) })
    }
  }
  return out.sort((x, y) => y.delta - x.delta || x.file.localeCompare(y.file) || x.line - y.line).slice(0, limit)
}

/** @param {string[]} base @param {string[]} head @returns {{ appeared: string[], disappeared: string[] }} */
export function setDelta(base, head) {
  const b = new Set(base), h = new Set(head)
  return { appeared: head.filter(x => !b.has(x)), disappeared: base.filter(x => !h.has(x)) }
}

/** @template T @param {Result<T>} r @returns {string} */
const failCell = r => (r.status === 'not-measured' ? 'not measured' : 'failed to measure')

/** @param {number} n */
const signed = n => (n > 0 ? `+${n}` : String(n))

/** Markdown-safe text for a table cell. @param {string} s */
export const md = s => s.replace(/\|/g, '\\|')

/**
 * One table row from two results and a projection: a number, or a text that stands for none (a partial
 * total), which shows as itself and leaves no Δ.
 * @template T @param {string} label @param {Result<T>} base @param {Result<T>} head @param {(v: T) => number | string} get
 * @returns {string}
 */
export function row(label, base, head, get) {
  const b = base.status === 'ok' ? get(base.value) : failCell(base)
  const h = head.status === 'ok' ? get(head.value) : failCell(head)
  const delta = typeof b === 'number' && typeof h === 'number' ? signed(h - b) : '—'
  return `| ${label} | ${b} | ${h} | ${delta} |`
}

