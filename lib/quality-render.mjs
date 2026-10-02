// The quality delta as Markdown for the job summary (realm @nick/craft, #147): one table of base, head
// and Δ, the top risers, what Knip saw change, and every metric not measured or failed to measure named
// with its reason — never shown as 0. The CLI is lib/quality-delta.mjs.
import { NEW_FUNCTION_THRESHOLD, risers, setDelta } from './quality-diff.mjs'

/** @typedef {import('./quality-measure.mjs').Measure} Measure */
/** @typedef {import('./quality-eslint.mjs').Complexity} Complexity */
/** @template T @typedef {import('./quality-result.mjs').Result<T>} Result */

/** @template T @param {Result<T>} r @returns {string} */
const failCell = r => (r.status === 'not-measured' ? 'not measured' : 'failed to measure')

/** @param {number} n */
const signed = n => (n > 0 ? `+${n}` : String(n))

/**
 * One table row from two results and a projection to a number.
 * @template T @param {string} label @param {Result<T>} base @param {Result<T>} head @param {(v: T) => number} get
 * @returns {string}
 */
function row(label, base, head, get) {
  const b = base.status === 'ok' ? get(base.value) : null
  const h = head.status === 'ok' ? get(head.value) : null
  const delta = b != null && h != null ? signed(h - b) : '—'
  return `| ${label} | ${b ?? failCell(base)} | ${h ?? failCell(head)} | ${delta} |`
}

/** @type {[string, keyof Measure][]} */
const LABELS = [
  ['cyclomatic complexity', 'complexity'], ['engines (workflows/*.js)', 'engines'], ['cognitive complexity', 'cognitive'], ['lint problems', 'lint'],
  ['type errors', 'types'], ['engine check problems', 'engineChecks'], ['tests', 'tests'], ['knip', 'knip'], ['import cycles', 'cycles'],
]

/**
 * The not-measured lines and failure lines of one metric. Both sides not measured for one reason read
 * as one line: "cognitive complexity: not measured (...)".
 * @param {string} label @param {Result<unknown>} b @param {Result<unknown>} h
 * @returns {{ notMeasured: string[], errors: string[] }}
 */
function unmeasuredOne(label, b, h) {
  if (b.status === 'not-measured' && h.status === 'not-measured' && b.reason === h.reason) {
    return { notMeasured: [`${label}: not measured (${b.reason})`], errors: [] }
  }
  /** @type {{ notMeasured: string[], errors: string[] }} */
  const out = { notMeasured: [], errors: [] }
  for (const [side, r] of /** @type {const} */ ([['base', b], ['head', h]])) {
    if (r.status === 'not-measured') out.notMeasured.push(`${label}: not measured on ${side} (${r.reason})`)
    if (r.status === 'failed') out.errors.push(`${label} on ${side}: ${r.reason}`)
  }
  return out
}

/** @param {string} s */
const md = s => s.replace(/\|/g, '\\|')

/** @param {Measure} base @param {Measure} head @returns {string[]} */
function table(base, head) {
  /** @param {Complexity} c */
  const total = c => c.total
  /** @param {number} n */
  const id = n => n
  return [
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    row('Cyclomatic complexity (source only, tests excluded)', base.complexity, head.complexity, total),
    row('… of which engines (workflows/*.js)', base.engines, head.engines, total),
    row('Source functions measured', base.complexity, head.complexity, c => c.functions.length),
    row('Cognitive complexity (source only, tests excluded)', base.cognitive, head.cognitive, total),
    row('Lint problems', base.lint, head.lint, id),
    row('Type errors (TS diagnostics, each once across the check:types* scripts)', base.types, head.types, id),
    row('Engine check problems (any ceiling, no-unsafe-*; not type errors)', base.engineChecks, head.engineChecks, id),
    row('Tests passed', base.tests, head.tests, t => t.passed),
    row('Tests failed', base.tests, head.tests, t => t.failed),
    row('Knip: unused files', base.knip, head.knip, k => k.files.length),
    row('Knip: unused exports', base.knip, head.knip, k => k.exports.length),
    row('Knip: unused dependencies', base.knip, head.knip, k => k.dependencies.length),
    row('Knip: other issues (unlisted, unresolved, binaries, enum or namespace members, duplicates)', base.knip, head.knip, k => k.other.length),
    row('Import cycles (edges in a cycle)', base.cycles, head.cycles, id),
  ]
}

/** @param {string} title @param {Result<Complexity>} b @param {Result<Complexity>} h @returns {string[]} */
function riserSection(title, b, h) {
  if (b.status !== 'ok' || h.status !== 'ok') return []
  const top = risers(b.value, h.value)
  const head = ['', `**${title} complexity — top risers** (rose, or new above ${NEW_FUNCTION_THRESHOLD})`, '']
  if (!top.length) return [...head, 'none']
  return [...head, '| Function | Where (head) | Base | Head | Δ |', '|---|---|---|---|---|',
    ...top.map(r => `| ${md(r.name)} | \`${r.file}:${r.line}\` | ${r.base ?? 'new'} | ${r.head} | +${r.delta} |`)]
}

/** @param {Measure} base @param {Measure} head @returns {string[]} */
function knipChanges(base, head) {
  if (base.knip.status !== 'ok' || head.knip.status !== 'ok') return []
  const b = base.knip.value, h = head.knip.value
  const kinds = /** @type {const} */ ([['files', 'unused file'], ['exports', 'unused export'], ['dependencies', 'unused dependency'], ['other', 'issue']])
  const lines = kinds.flatMap(([kind, word]) => {
    const d = setDelta(b[kind], h[kind])
    return [...d.appeared.map(x => `- ${word} appeared: \`${x}\``), ...d.disappeared.map(x => `- ${word} gone: \`${x}\``)]
  })
  return lines.length ? ['', '**Knip (production) — what changed**', '', ...lines] : []
}

/** @param {Measure} base @param {Measure} head @returns {string[]} */
function gaps(base, head) {
  const all = LABELS.map(([label, key]) => unmeasuredOne(label, base[key], head[key]))
  const notMeasured = all.flatMap(x => x.notMeasured), errors = all.flatMap(x => x.errors)
  return [
    ...(notMeasured.length ? ['', '**Not measured**', '', ...notMeasured.map(l => `- ${l}`)] : []),
    ...(errors.length ? ['', '**Failed to measure** (shown as such above, not as 0)', '', ...errors.map(l => `- ${md(l)}`)] : []),
  ]
}

/**
 * The Markdown summary for $GITHUB_STEP_SUMMARY.
 * @param {Measure} base @param {Measure} head @param {{ seconds?: number }} [info] @returns {string}
 */
export function renderSummary(base, head, info = {}) {
  return [
    '### Quality delta, base → head',
    '',
    'A signal for review, not a gate: nothing here fails the PR; the gate keeps its own zeros.',
    'Complexity is over source only, tests excluded (`*.test.*`): lint\'s scope plus the engines (`workflows/*.js`, wrapped'
      + ' as the engine checks wrap them); lint problems count every linted file.',
    '',
    ...table(base, head),
    ...riserSection('Cyclomatic', base.complexity, head.complexity),
    ...riserSection('Cognitive', base.cognitive, head.cognitive),
    ...knipChanges(base, head),
    ...gaps(base, head),
    '',
    '_Risers are paired by file and name; unnamed functions (e.g. "Arrow function") by their order among'
      + ' same-named ones in a file, so a riser among them can be a shifted pairing._',
    ...(info.seconds != null ? ['', `_Measured in ${info.seconds}s._`] : []),
  ].join('\n') + '\n'
}
