import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baselineCount, ceilingProblems, checkDup } from './check-dup.mjs'

/** @param {Record<string, string>} files @returns {string} */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-dup-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const COPY = 'export function f(x) {\n  return x + 1\n}\n'

test('baselineCount: a null baseline, a non-object fingerprints, a fraction is unreadable; a zero count is a count', () => {
  assert.equal(baselineCount(null), null)
  assert.equal(baselineCount({ fingerprints: 5 }), null)
  assert.equal(baselineCount({ fingerprints: [] }), null)
  assert.equal(baselineCount({ fingerprints: { a: 1.5 } }), null)
  assert.equal(baselineCount({ fingerprints: { a: 0, b: 2 } }), 2)
})

test('ceilingProblems: a negative ceiling is no ceiling; zero is one', () => {
  assert.match(ceilingProblems({ baseline: 0, ceiling: -1, found: 0 }).join('\n'), /no ceiling/)
  assert.deepEqual(ceilingProblems({ baseline: 0, ceiling: 0, found: 0 }), [])
})

test('baselineCount: the sum of the fingerprint counts; anything else is unreadable', () => {
  assert.equal(baselineCount({ version: 1, fingerprints: { a: 1, b: 2 } }), 3)
  assert.equal(baselineCount({ version: 1, fingerprints: {} }), 0)
  assert.equal(baselineCount({ version: 1 }), null)
  assert.equal(baselineCount({ fingerprints: { a: '1' } }), null)
  assert.equal(baselineCount({ fingerprints: { a: -1 } }), null)
})

test('ceilingProblems: the baseline may only shrink, and the ceiling follows it down', () => {
  assert.deepEqual(ceilingProblems({ baseline: 10, ceiling: 10, found: 10 }), [])
  // A planted copy absorbed by regenerating the baseline.
  assert.match(ceilingProblems({ baseline: 11, ceiling: 10, found: 11 }).join('\n'), /11 accepted copies, above the ceiling 10/)
  // A copy unified away, the baseline regenerated: the ceiling must come down with it.
  assert.match(ceilingProblems({ baseline: 9, ceiling: 10, found: 9 }).join('\n'), /lower the ceiling to 9/)
  // A copy unified away, the baseline not regenerated: its stale fingerprint would admit a new copy later.
  assert.match(ceilingProblems({ baseline: 10, ceiling: 10, found: 9 }).join('\n'), /1 fingerprint\(s\) no longer found.*npm run check:dup:baseline/)
  assert.match(ceilingProblems({ baseline: 10, ceiling: Number.NaN, found: 10 }).join('\n'), /no ceiling/)
})

// The jscpd run is injected: each case writes the report jscpd would, and returns its exit.
const CONFIG = { path: ['lib'], ignore: ['**/*.test.mjs'] }
/** @param {{ isNew: boolean }[] | null} dups @param {{ status: number | null, error?: Error }} exit */
function gate(dups, exit) {
  const root = tree({
    '.jscpd.json': JSON.stringify(CONFIG),
    '.jscpd-baseline.json': JSON.stringify({ version: 1, fingerprints: { a: 1, b: 1 } }),
    'lib/dup-ceiling.json': JSON.stringify({ clones: 2 }),
    'lib/x.mjs': COPY,
  })
  try {
    return checkDup(root, (/** @type {string} */ r, /** @type {string} */ out) => {
      assert.equal(r, root)
      if (dups) fs.writeFileSync(path.join(out, 'jscpd-report.json'), JSON.stringify({ duplicates: dups, statistics: {} }))
      return exit
    }).join('\n')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const OLD = { isNew: false }

test('checkDup: the baselined clones and a clean exit pass', () => {
  assert.equal(gate([OLD, OLD], { status: 0 }), '')
})

test('checkDup: a clone the report marks new fails as a new copy — on a non-zero exit, and on a zero one too', () => {
  for (const status of [1, 0]) {
    const out = gate([OLD, OLD, { isNew: true }], { status })
    assert.match(out, /1 clone\(s\) not in \.jscpd-baseline\.json.*new copy/)
    assert.doesNotMatch(out, /could not run|failed/)
  }
})

test('checkDup: fewer clones found than the baseline lists fails, so the ceiling comes down', () => {
  assert.match(gate([OLD], { status: 0 }), /1 fingerprint\(s\) no longer found/)
  assert.match(gate([], { status: 0 }), /2 fingerprint\(s\) no longer found/)
})

test('checkDup: jscpd failing to run is not reported as a new copy, and still fails', () => {
  const missing = gate(null, { status: null, error: Object.assign(new Error('spawn jscpd ENOENT'), { code: 'ENOENT' }) })
  assert.match(missing, /jscpd could not run.*ENOENT.*npm ci/)
  const crashed = gate(null, { status: 2 })
  assert.match(crashed, /jscpd exited 2 without a report.*\.jscpd\.json/)
  // A non-zero exit whose report lists nothing new (failOnEmpty, a reporter error): a failure, not a copy.
  const empty = gate([OLD, OLD], { status: 1 })
  assert.match(empty, /jscpd exited 1 with no new clone in its report/)
  for (const out of [missing, crashed, empty]) assert.doesNotMatch(out, /new copy/)
})

/**
 * checkDup over a scratch tree: the gate inputs of `gate` with `over` laid on top (null deletes one),
 * jscpd injected to report `dups`. Returns the problems and the report directory jscpd was handed.
 * @param {Record<string, string | null>} over @param {unknown[] | null} dups @param {{ status: number | null }} [exit]
 */
function gateWith(over, dups, exit = { status: 0 }) {
  /** @type {Record<string, string>} */
  const files = {
    '.jscpd.json': JSON.stringify(CONFIG),
    '.jscpd-baseline.json': JSON.stringify({ version: 1, fingerprints: { a: 1, b: 1 } }),
    'lib/dup-ceiling.json': JSON.stringify({ clones: 2 }),
    'lib/x.mjs': COPY,
  }
  for (const [rel, body] of Object.entries(over)) { if (body === null) delete files[rel]; else files[rel] = body }
  const root = tree(files)
  /** @type {string[]} */
  const outs = []
  try {
    const problems = checkDup(root, (_r, /** @type {string} */ out) => {
      outs.push(out)
      if (dups) fs.writeFileSync(path.join(out, 'jscpd-report.json'), JSON.stringify({ duplicates: dups }))
      return exit
    })
    return { problems, outs }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('checkDup: an unreadable gate input stops it before jscpd runs', () => {
  const { problems, outs } = gateWith({ 'lib/dup-ceiling.json': null }, [OLD, OLD])
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /^unreadable gate input: .*dup-ceiling\.json/)
  assert.deepEqual(outs, [])
})

test('checkDup: a baseline that is not one stops it', () => {
  assert.deepEqual(gateWith({ '.jscpd-baseline.json': '{}' }, [OLD, OLD]).problems,
    ['.jscpd-baseline.json is not a jscpd baseline ({ fingerprints: { <hash>: <count> } })'])
})

test('checkDup: a malformed entry in the report is no new clone, and the report directory is removed', () => {
  const { problems, outs } = gateWith({}, [null, 'x', OLD], { status: 0 })
  assert.deepEqual(problems, [])
  assert.equal(outs.length, 1)
  assert.equal(fs.existsSync(outs[0] ?? ''), false, 'the report directory outlived the run')
})

test('checkDup: jscpd killed by a signal, with no report, says so', () => {
  assert.deepEqual(gateWith({}, null, { status: null }).problems,
    ['jscpd exited on a signal without a report — see its output above: a missing platform package (run npm ci) or an error in .jscpd.json'])
})

// The real launcher, against a stand-in jscpd at the root's own .bin: what it is asked, from where.
test('checkDup runs the root\'s own jscpd with a JSON report into a scratch directory, and fails closed without it', { skip: process.platform === 'win32' }, () => {
  const fake = '#!/bin/sh\nprintf \'%s\\n\' "$@" > args.txt\nprintf \'{"duplicates":[{"isNew":false},{"isNew":false}]}\' > "$4/jscpd-report.json"\n'
  const root = tree({
    '.jscpd.json': JSON.stringify(CONFIG),
    '.jscpd-baseline.json': JSON.stringify({ version: 1, fingerprints: { a: 1, b: 1 } }),
    'lib/dup-ceiling.json': JSON.stringify({ clones: 2 }),
    'lib/x.mjs': COPY,
  })
  try {
    assert.match(checkDup(root).join('\n'), /^jscpd could not run \(.*ENOENT.*\) — run npm ci$/)
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'jscpd'), fake, { mode: 0o755 })
    assert.deepEqual(checkDup(root), [])
    const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').trimEnd().split('\n')
    assert.deepEqual(args.slice(0, 3), ['--reporters', 'console,json', '--output'])
    assert.equal(args.length, 4)
    assert.equal(fs.existsSync(args[3] ?? ''), false, 'the report directory outlived the run')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
