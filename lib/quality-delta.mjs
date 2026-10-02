// How quality moved between a PR's base and head, as Markdown for the job summary — a signal for review,
// never a gate (realm @nick/craft, #147): the CLI exits 0 whatever it measured, and a metric it could
// not measure is said to be so, never shown as 0. Measuring lives in lib/quality-measure.mjs.
//   node lib/quality-delta.mjs --base <checkout> --head <checkout>
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureCheckout } from './quality-measure.mjs'

/** @typedef {import('./quality-measure.mjs').Measure} Measure */
/** @typedef {import('./quality-eslint.mjs').Complexity} Complexity */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */
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

/** @template T @param {Result<T>} r @returns {string} */
const failCell = r => (r.status === 'not-measured' ? 'not measured' : 'failed to measure')

/**
 * One table row from two results and a projection to a number.
 * @template T @param {string} label @param {Result<T>} base @param {Result<T>} head @param {(v: T) => number} get
 * @returns {string}
 */
function row(label, base, head, get) {
  const b = base.status === 'ok' ? get(base.value) : null
  const h = head.status === 'ok' ? get(head.value) : null
  const delta = b != null && h != null ? (h - b > 0 ? `+${h - b}` : String(h - b)) : '—'
  return `| ${label} | ${b ?? failCell(base)} | ${h ?? failCell(head)} | ${delta} |`
}

/** The metrics not measured or failed, with the reason, per side. @param {Measure} base @param {Measure} head */
function unmeasured(base, head) {
  /** @type {string[]} */
  const notMeasured = []
  /** @type {string[]} */
  const errors = []
  for (const [label, key] of LABELS) {
    const b = base[key], h = head[key]
    // Both sides not measured for one reason read as one line: "cognitive complexity: not measured (...)".
    if (b.status === 'not-measured' && h.status === 'not-measured' && b.reason === h.reason) {
      notMeasured.push(`${label}: not measured (${b.reason})`)
      continue
    }
    for (const [side, r] of /** @type {const} */ ([['base', b], ['head', h]])) {
      if (r.status === 'not-measured') notMeasured.push(`${label}: not measured on ${side} (${r.reason})`)
      if (r.status === 'failed') errors.push(`${label} on ${side}: ${r.reason}`)
    }
  }
  return { notMeasured, errors }
}

/** @type {[string, keyof Measure][]} */
const LABELS = [
  ['cyclomatic complexity', 'complexity'], ['cognitive complexity', 'cognitive'], ['lint problems', 'lint'],
  ['type errors', 'types'], ['tests', 'tests'], ['knip', 'knip'], ['import cycles', 'cycles'],
]

/** @param {string} s */
const md = s => s.replace(/\|/g, '\\|')

/**
 * The Markdown summary for $GITHUB_STEP_SUMMARY.
 * @param {Measure} base @param {Measure} head @param {{ seconds?: number }} [info] @returns {string}
 */
export function renderSummary(base, head, info = {}) {
  /** @param {Complexity} c */
  const total = c => c.total
  const lines = [
    '### Quality delta, base → head',
    '',
    'A signal for review, not a gate: nothing here fails the PR; the gate keeps its own zeros.',
    'Complexity is over source only, tests excluded (`*.test.*`); lint problems count every linted file.',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    row('Cyclomatic complexity (source only, tests excluded)', base.complexity, head.complexity, total),
    row('Source functions measured', base.complexity, head.complexity, c => c.functions.length),
    row('Cognitive complexity (source only, tests excluded)', base.cognitive, head.cognitive, total),
    row('Lint problems', base.lint, head.lint, n => n),
    row('Type errors', base.types, head.types, n => n),
    row('Tests passed', base.tests, head.tests, t => t.passed),
    row('Tests failed', base.tests, head.tests, t => t.failed),
    row('Knip: unused files', base.knip, head.knip, k => k.files.length),
    row('Knip: unused exports', base.knip, head.knip, k => k.exports.length),
    row('Knip: unused dependencies', base.knip, head.knip, k => k.dependencies.length),
    row('Import cycles (edges in a cycle)', base.cycles, head.cycles, n => n),
  ]
  for (const [title, key] of /** @type {const} */ ([['Cyclomatic', 'complexity'], ['Cognitive', 'cognitive']])) {
    const b = base[key], h = head[key]
    if (b.status !== 'ok' || h.status !== 'ok') continue
    const top = risers(b.value, h.value)
    lines.push('', `**${title} complexity — top risers** (rose, or new above ${NEW_FUNCTION_THRESHOLD})`, '')
    if (!top.length) { lines.push('none'); continue }
    lines.push('| Function | Where (head) | Base | Head | Δ |', '|---|---|---|---|---|')
    for (const r of top) lines.push(`| ${md(r.name)} | \`${r.file}:${r.line}\` | ${r.base ?? 'new'} | ${r.head} | +${r.delta} |`)
  }
  if (base.knip.status === 'ok' && head.knip.status === 'ok') {
    /** @type {string[]} */
    const knipLines = []
    for (const kind of /** @type {const} */ (['files', 'exports', 'dependencies'])) {
      const d = setDelta(base.knip.value[kind], head.knip.value[kind])
      for (const x of d.appeared) knipLines.push(`- unused ${kind.replace(/s$/, '')} appeared: \`${x}\``)
      for (const x of d.disappeared) knipLines.push(`- unused ${kind.replace(/s$/, '')} gone: \`${x}\``)
    }
    if (knipLines.length) lines.push('', '**Knip (production) — what changed**', '', ...knipLines)
  }
  const { notMeasured, errors } = unmeasured(base, head)
  if (notMeasured.length) lines.push('', '**Not measured**', '', ...notMeasured.map(l => `- ${l}`))
  if (errors.length) lines.push('', '**Failed to measure** (shown as such above, not as 0)', '', ...errors.map(l => `- ${md(l)}`))
  lines.push('', '_Risers are paired by file and name; unnamed functions (e.g. "Arrow function") by their order among'
    + ' same-named ones in a file, so a riser among them can be a shifted pairing._')
  if (info.seconds != null) lines.push('', `_Measured in ${info.seconds}s._`)
  return lines.join('\n') + '\n'
}

/** @param {string[]} argv @returns {{ base: string, head: string } | null} */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1]
    if ((k !== '--base' && k !== '--head') || v === undefined) return null
    opts[k.slice(2)] = v
  }
  const base = opts['base'], head = opts['head']
  return base && head ? { base: path.resolve(base), head: path.resolve(head) } : null
}

/** @param {string[]} argv @returns {Promise<number>} exit code: 0 after any measurement, 2 on bad usage */
export async function main(argv) {
  const args = parseArgs(argv)
  if (!args) {
    console.error('usage: node lib/quality-delta.mjs --base <checkout> --head <checkout>')
    return 2
  }
  const started = Date.now()
  const [base, head] = [await measureCheckout(args.base), await measureCheckout(args.head)]
  process.stdout.write(renderSummary(base, head, { seconds: Math.round((Date.now() - started) / 1000) }))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
