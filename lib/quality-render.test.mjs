import { test } from 'vitest'
import assert from 'node:assert/strict'
import { renderSummary } from './quality-render.mjs'

/** @typedef {import('./quality-measure.mjs').Measure} Measure */

const cx = { total: 3, functions: [{ key: 'f', name: 'f', file: 'lib/a.mjs', line: 1, value: 3 }], bar: 10 }
const knip = { files: ['a'], exports: ['b', 'c'], dependencies: [], other: [] }

/** Every metric measured. @param {Partial<Measure>} [over] @returns {Measure} */
const measure = (over = {}) => ({
  complexity: { status: 'ok', value: cx },
  engines: { status: 'ok', value: { total: 0, functions: [] } },
  cognitive: { status: 'ok', value: cx },
  lint: { status: 'ok', value: 1 },
  types: { status: 'ok', value: 2 },
  engineChecks: { status: 'ok', value: 3 },
  tests: { status: 'ok', value: { passed: 4, failed: 5, skipped: 0 } },
  knip: { status: 'ok', value: knip },
  cycles: { status: 'ok', value: 6 },
  ...over,
})

const TRAILER = '_Risers are paired by file and name; unnamed functions (e.g. "Arrow function") by their order among'
  + ' same-named ones in a file, so a riser among them can be a shifted pairing._'

/** The lines between the top risers and the trailer: Knip's changes and the gaps. @param {string} out */
const tailOf = out => out.slice(out.lastIndexOf('none\n') + 'none\n'.length, out.indexOf(TRAILER))

test('renderSummary: all measured, nothing changed in Knip — the whole summary, exactly', () => {
  const head = measure({ tests: { status: 'ok', value: { passed: 7, failed: 1, skipped: 0 } } })
  assert.equal(renderSummary(measure(), head, { seconds: 0 }), [
    '### Quality delta, base → head',
    '',
    'A signal for review, not a gate: nothing here fails the PR; the gate keeps its own zeros.',
    'Complexity is over source only, tests excluded (`*.test.*`): lint\'s scope plus the engines (`src/*.js`, wrapped'
      + ' as the engine checks wrap them); lint problems count every linted file.',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    '| Cyclomatic complexity (source only, tests excluded) | 3 | 3 | 0 |',
    '| … of which lint\'s scope | 3 | 3 | 0 |',
    '| … of which engines (src/*.js) | 0 | 0 | 0 |',
    '| Source functions measured | 1 | 1 | 0 |',
    '| Cognitive complexity (source only, tests excluded) | 3 | 3 | 0 |',
    '| … of which lint\'s scope | 3 | 3 | 0 |',
    '| Lint problems | 1 | 1 | 0 |',
    '| Type errors (TS diagnostics, each once across the check:types* scripts) | 2 | 2 | 0 |',
    '| Engine check problems (any ceiling, no-unsafe-*, complexity bars; not type errors) | 3 | 3 | 0 |',
    '| Tests passed | 4 | 7 | +3 |',
    '| Tests failed | 5 | 1 | -4 |',
    '| Knip: unused files | 1 | 1 | 0 |',
    '| Knip: unused exports | 2 | 2 | 0 |',
    '| Knip: unused dependencies | 0 | 0 | 0 |',
    '| Knip: other issues (unlisted, unresolved, binaries, enum or namespace members, duplicates) | 0 | 0 | 0 |',
    '| Import cycles (edges in a cycle) | 6 | 6 | 0 |',
    '',
    '**Cyclomatic complexity — top risers** (rose, or new above 10)',
    '',
    'none',
    '',
    '**Cognitive complexity — top risers** (rose, or new above 10)',
    '',
    'none',
    '',
    TRAILER,
    '',
    '_Measured in 0s._',
    '',
  ].join('\n'))
})

test('renderSummary: no time given, no "Measured in" line', () => {
  assert.ok(renderSummary(measure(), measure()).endsWith(`none\n\n${TRAILER}\n`))
})

test('renderSummary: every kind Knip saw change, appeared before gone, in the kinds\' order', () => {
  const head = measure({ knip: { status: 'ok', value: { files: ['z'], exports: ['b'], dependencies: ['d'], other: ['e'] } } })
  assert.equal(tailOf(renderSummary(measure(), head)), [
    '',
    '**Knip (production) — what changed**',
    '',
    '- unused file appeared: `z`',
    '- unused file gone: `a`',
    '- unused export gone: `c`',
    '- unused dependency appeared: `d`',
    '- issue appeared: `e`',
    '',
    '',
  ].join('\n'))
})

test('renderSummary: Knip unmeasured on either side or both lists no change and does not throw', () => {
  const down = /** @type {const} */ ({ status: 'failed', reason: 'knip broke' })
  for (const [b, h] of [[down, undefined], [undefined, down], [down, down]]) {
    const out = renderSummary(measure(b ? { knip: b } : {}), measure(h ? { knip: h } : {}))
    assert.doesNotMatch(out, /Knip \(production\)/)
  }
})

test('renderSummary: each gap is named on its side, one line when both sides share a not-measured reason', () => {
  const nm = (/** @type {string} */ reason) => /** @type {const} */ ({ status: 'not-measured', reason })
  const fail = (/** @type {string} */ reason) => /** @type {const} */ ({ status: 'failed', reason })
  const base = measure({ lint: nm('same'), types: nm('b-only'), engineChecks: fail('x'), tests: nm('x'), cycles: fail('a|b') })
  const head = measure({ lint: nm('same'), types: nm('h-only'), engineChecks: nm('x'), tests: fail('x'), knip: fail('k') })
  assert.equal(tailOf(renderSummary(base, head)), [
    '',
    '**Not measured**',
    '',
    '- lint problems: not measured (same)',
    '- type errors: not measured on base (b-only)',
    '- type errors: not measured on head (h-only)',
    '- engine check problems: not measured on head (x)',
    '- tests: not measured on base (x)',
    '',
    '**Failed to measure** (shown as such above, not as 0)',
    '',
    '- engine check problems on base: x',
    '- tests on head: x',
    '- knip on head: k',
    '- import cycles on base: a\\|b',
    '',
    '',
  ].join('\n'))
})

test('renderSummary: only failures — no "Not measured" heading', () => {
  const out = tailOf(renderSummary(measure({ lint: { status: 'failed', reason: 'boom' } }), measure()))
  assert.equal(out, '\n**Failed to measure** (shown as such above, not as 0)\n\n- lint problems on base: boom\n\n')
})
