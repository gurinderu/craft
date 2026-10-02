// The comparisons behind the quality delta (realm @nick/craft, #147): which functions rose between base
// and head, and which identifiers appeared or went. Rendered by lib/quality-render.mjs.

/** @typedef {import('./quality-eslint.mjs').Complexity} Complexity */
/** @typedef {{ name: string, file: string, line: number, base: number | null, head: number, delta: number }} Riser */

/** A new function counts as a riser above this cyclomatic complexity; one that existed, on any rise. */
export const NEW_FUNCTION_THRESHOLD = 10
const TOP = 10

/**
 * Functions whose value rose, or that are new above the threshold, largest rise first.
 * @param {Complexity} base @param {Complexity} head @param {number} [threshold] @param {number} [limit]
 * @returns {Riser[]}
 */
export function risers(base, head, threshold = NEW_FUNCTION_THRESHOLD, limit = TOP) {
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
