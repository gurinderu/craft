// Source rules for the engines (workflows/*.js) that the type check cannot express (realm @nick/craft, #136).
// - The sandbox throws on Date.now(), Math.random() and an argless `new Date` (they would break resume),
//   yet es2023 declares all three, so tsc accepts them: they are refused here, in code and in inlined
//   lib regions alike — an inlined module runs in the sandbox too.
// - An `any` in a JSDoc type switches the check off for its value as @ts-ignore would. Each engine's
//   count is held to a committed ceiling that can only fall: above it is a new hole, below it is a
//   stale ceiling that must be lowered in the same change.
import { findRegions } from './inline-regions.mjs'

const FORBIDDEN = [
  { re: /\bDate\s*\.\s*now\s*\(/, what: 'Date.now()' },
  { re: /\bMath\s*\.\s*random\s*\(/, what: 'Math.random()' },
  { re: /\bnew\s+Date\b\s*(?:\(\s*\)|(?![\s(]))/, what: 'an argless new Date' },
]

/** A line with its comment removed: a whole-line comment goes, and so does a trailing ` // …`. @param {string} line @returns {string} */
function codeOf(line) {
  if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return ''
  return line.replace(/\s\/\/\s.*$/, '')
}

/** @param {string} src @param {string} file @returns {string[]} */
export function forbiddenCalls(src, file) {
  /** @type {string[]} */
  const out = []
  src.split('\n').forEach((l, i) => {
    const code = codeOf(l)
    for (const f of FORBIDDEN) if (f.re.test(code)) out.push(`${file}:${i + 1} calls ${f.what}, which the Workflow sandbox throws on`)
  })
  return out
}

const TYPE_TAG = /@(?:type|param|returns?|typedef|property|prop|satisfies|template|this|callback)\s*\{/g

/**
 * `any` inside JSDoc type expressions, outside craft-inline regions (those are lib code, checked there).
 * @param {string} src @returns {number}
 */
export function countAny(src) {
  const lines = src.split('\n')
  for (const r of findRegions(src)) for (let i = r.open; i <= r.close; i++) lines[i] = ''
  const text = lines.join('\n')
  let n = 0
  for (const m of text.matchAll(TYPE_TAG)) {
    let depth = 1
    let j = /** @type {number} */ (m.index) + m[0].length
    const start = j
    for (; j < text.length && depth; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
    }
    n += (text.slice(start, j - 1).match(/\bany\b/g) || []).length
  }
  return n
}

/**
 * @param {Record<string, number>} counts  per engine file, as measured
 * @param {Record<string, unknown>} ceiling  per engine file, as committed
 * @param {string[]} engines  every engine file, counted or not (one with a broken fence is reported elsewhere)
 * @returns {string[]}
 */
export function anyCeilingProblems(counts, ceiling, engines = Object.keys(counts)) {
  /** @type {string[]} */
  const out = []
  for (const [file, n] of Object.entries(counts)) {
    const cap = ceiling[file]
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) { out.push(`${file}: no ceiling for its ${n} \`any\` type(s) in lib/engine-any-ceiling.json`); continue }
    if (n > cap) out.push(`${file}: ${n} \`any\` types, above the ceiling ${cap} — type the new value instead`)
    else if (n < cap) out.push(`${file}: ${n} \`any\` types, below the ceiling ${cap} — lower the ceiling to ${n} in lib/engine-any-ceiling.json`)
  }
  for (const file of Object.keys(ceiling)) if (!engines.includes(file)) out.push(`lib/engine-any-ceiling.json names ${file}, which is not an engine`)
  return out
}
