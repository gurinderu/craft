// The complexity part of the quality-delta summary (realm @nick/craft, #147): the totals, their parts, and
// the top risers. A total that lacks a part on a side (the engines, when they could not be measured) is
// shown as partial with no Δ, never as a smaller number; the parts measured on both sides keep their rows,
// and the risers compare only what both sides measured.
import { md, risers, row } from './quality-diff.mjs'
import { isEngineFile } from './quality-tally.mjs'

/** @typedef {import('./quality-measure.mjs').Measure} Measure */
/** @typedef {import('./quality-tally.mjs').Complexity} Complexity */
/** @typedef {import('./quality-tally.mjs').Tally} Tally */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */

/** @param {Complexity} c @returns {string | null} */
const partialText = c => (c.partial ? `partial — ${c.partial.part} not measured (${md(c.partial.reason)})` : null)

/** @param {(c: Complexity) => number} get @returns {(c: Complexity) => number | string} */
const whole = get => c => partialText(c) ?? get(c)

/** @param {Complexity} c */
const scopeTotal = c => c.functions.filter(f => !isEngineFile(f.file)).reduce((s, f) => s + f.value, 0)

/** @param {Measure} base @param {Measure} head @returns {string[]} */
export function complexityRows(base, head) {
  /** @param {Tally} c */
  const total = c => c.total
  return [
    row('Cyclomatic complexity (source only, tests excluded)', base.complexity, head.complexity, whole(total)),
    row('… of which lint\'s scope', base.complexity, head.complexity, scopeTotal),
    row('… of which engines (src/*.js)', base.engines, head.engines, total),
    row('Source functions measured', base.complexity, head.complexity, whole(c => c.functions.length)),
    row('Cognitive complexity (source only, tests excluded)', base.cognitive, head.cognitive, whole(total)),
    row('… of which lint\'s scope', base.cognitive, head.cognitive, scopeTotal),
  ]
}

/**
 * Both sides' functions limited to what both measured: a part missing on either side is left out of both.
 * @param {Complexity} b @param {Complexity} h @returns {{ b: Tally, h: Tally, left: string | null }}
 */
function comparable(b, h) {
  const gap = b.partial ?? h.partial
  if (!gap) return { b, h, left: null }
  /** @param {Tally} t @returns {Tally} */
  const keep = t => ({ total: 0, functions: t.functions.filter(f => !isEngineFile(f.file)) })
  return { b: keep(b), h: keep(h), left: `_The risers leave out ${gap.part}, not measured on one side._` }
}

/** @param {string} title @param {Result<Complexity>} base @param {Result<Complexity>} head @returns {string[]} */
export function riserSection(title, base, head) {
  if (base.status !== 'ok' || head.status !== 'ok') return []
  const { b, h, left } = comparable(base.value, head.value)
  const top = risers(b, h, head.value.bar)
  const lines = ['', `**${title} complexity — top risers** (rose, or new above ${head.value.bar})`, '', ...(left ? [left, ''] : [])]
  if (!top.length) return [...lines, 'none']
  return [...lines, '| Function | Where (head) | Base | Head | Δ |', '|---|---|---|---|---|',
    ...top.map(r => `| ${md(r.name)} | \`${r.file}:${r.line}\` | ${r.base ?? 'new'} | ${r.head} | +${r.delta} |`)]
}
