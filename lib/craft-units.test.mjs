// The units CLI (lib/craft-units.mjs) and its pure half (lib/cargo-units.mjs; realm @nick/craft, #377): what
// cargo metadata, git ls-files, git grep and git diff print, reshaped into the unit probe's answer.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { cargoPackages, countLines, numstatLines, packageLines, parseGrepCounts, parseLsFiles, unitsAnswer } from './cargo-units.mjs'
import { badRange, collectUnits, run } from './craft-units.mjs'
import { parseNumstat, parsePackageLines } from './unit-graph.mjs'
import { UNITS_SCHEMA } from './review-unit-schemas.mjs'
import { RUST_UNITS } from './rust-units.mjs'

// `cargo metadata --format-version 1 --no-deps` of a 2-crate workspace at /w, cut to the fields read.
const CARGO_METADATA = {
  workspace_root: '/w',
  packages: [
    { name: 'demo-net', manifest_path: '/w/crates/net/Cargo.toml', dependencies: [
      { name: 'demo-core', rename: 'core', kind: null }, { name: 'tokio', kind: null }, { name: 'tokio', kind: 'dev' },
    ] },
    { name: 'demo-core', manifest_path: '/w/crates/core/Cargo.toml', dependencies: [{ name: 'serde', kind: null }, { name: 'serde', kind: 'build' }] },
  ],
}
const FILES = ['Cargo.toml', 'crates/core/Cargo.toml', 'crates/core/src/lib.rs', 'crates/core/src/util.rs', 'crates/net/src/main.rs', 'crates/net/assets/logo.png', 'crates/net/README.md']
const RS = { '/w/crates/core/src/lib.rs': 100, '/w/crates/core/src/util.rs': 20, '/w/crates/net/src/main.rs': 45 }

/**
 * Commands answered from the fixture, each overridable by a string (its stdout) or an error (thrown); the calls kept.
 * @param {{ cargo?: string | Error, grep?: string | Error, diff?: string | Error }} [over]
 */
function fakeIo(over = {}) {
  /** @type {string[][]} */
  const calls = []
  /** @param {string | Error} v */
  const give = v => { if (v instanceof Error) throw v; return v }
  /** @param {string} cmd @param {string[]} args */
  const exec = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'cargo') return give(over.cargo ?? JSON.stringify(CARGO_METADATA))
    if (args[0] === 'rev-parse') return '/w\n'
    if (args.includes('ls-files')) return `${FILES.join('\0')}\0`
    if (args.includes('grep')) return give(over.grep ?? 'crates/core/src/lib.rs\x005\ncrates/core/src/util.rs\x002\ncrates/net/README.md\x003\n')
    return give(over.diff ?? '12\t3\tcrates/core/src/lib.rs\n-\t-\tcrates/net/assets/logo.png\n4\t0\tcrates/net/src/main.rs\n')
  }
  /** @param {string} f */
  const readFile = f => '\n'.repeat(/** @type {Record<string, number>} */ (RS)[f] ?? 0)
  return { exec, readFile, calls }
}

test('cargo metadata of a 2-crate workspace: each package by its directory, its dependencies by package name, sorted', () => {
  assert.deepEqual(cargoPackages(CARGO_METADATA, '/w'), [
    { dir: 'crates/core', name: 'demo-core', deps: ['serde'] },
    { dir: 'crates/net', name: 'demo-net', deps: ['demo-core', 'tokio'] },
  ], 'a renamed dependency counts by its package name; dev and build dependencies count; repeats once')
})

test('cargo metadata: a root package is ".", a manifest outside the repository and a nameless package are dropped', () => {
  const meta = { packages: [
    { name: 'root', manifest_path: '/w/Cargo.toml', dependencies: [] },
    { name: 'outside', manifest_path: '/elsewhere/x/Cargo.toml', dependencies: [] },
    { name: 'sibling', manifest_path: '/w-evil/Cargo.toml', dependencies: [] },
    { manifest_path: '/w/crates/anon/Cargo.toml' },
  ] }
  assert.deepEqual(cargoPackages(meta, '/w/'), [{ dir: '.', name: 'root', deps: [] }])
  assert.deepEqual(cargoPackages(null, '/w'), [])
  assert.deepEqual(cargoPackages({ packages: 'x' }, '/w'), [])
})

test('numstat lines: verbatim, a binary file as `-\\t-\\t<path>`, blank lines dropped; the slicer reads a binary as 0 lines', () => {
  const lines = numstatLines('3\t1\tcrates/core/src/lib.rs\n-\t-\tassets/logo.png\n10\t0\tdir with space/a.rs\n\n')
  assert.deepEqual(lines, ['3\t1\tcrates/core/src/lib.rs', '-\t-\tassets/logo.png', '10\t0\tdir with space/a.rs'])
  assert.deepEqual([...parseNumstat(lines)], [['crates/core/src/lib.rs', 4], ['assets/logo.png', 0], ['dir with space/a.rs', 10]])
})

test('git ls-files -z and git grep -c -z output, and newline counting as wc -l', () => {
  assert.deepEqual(parseLsFiles('a.rs\0dir/b c.rs\0'), ['a.rs', 'dir/b c.rs'])
  assert.deepEqual([...parseGrepCounts('a.rs\x003\nd:ir/b.rs\x0012\nbroken\n\0x\n')], [['a.rs', 3], ['d:ir/b.rs', 12]])
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\nb'), 1, 'a last line without a newline is not counted, as wc -l does not')
})

test('package lines: sizes summed over the files under each directory, a nested package counted in its parent too', () => {
  const pkgs = [{ dir: '.', name: 'top', deps: ['inner'] }, { dir: 'inner', name: 'inner', deps: [] }]
  const rs = new Map([['src/main.rs', 10], ['inner/src/lib.rs', 5], ['innerx/a.rs', 7]])
  const pub = new Map([['inner/src/lib.rs', 2], ['README.md', 1]])
  assert.deepEqual(packageLines(pkgs, rs, pub), ['@@ . 22 3 top inner', '@@ inner 5 2 inner'], '`innerx/` is not under `inner/`')
})

test('collectUnits: the answer fits UNITS_SCHEMA and parses as the prose probe\'s lines would', () => {
  const answer = collectUnits(['--merge-base', 'main'], fakeIo())
  assert.deepEqual(answer, {
    roots: ['crates/core', 'crates/net'],
    packages: ['@@ crates/core 120 7 demo-core serde', '@@ crates/net 45 3 demo-net demo-core tokio'],
    numstat: ['12\t3\tcrates/core/src/lib.rs', '-\t-\tcrates/net/assets/logo.png', '4\t0\tcrates/net/src/main.rs'],
  })
  assert.deepEqual(Object.keys(answer).filter(k => !(k in /** @type {Record<string, unknown>} */ (UNITS_SCHEMA['properties']))), [], 'no key the schema refuses')
  assert.deepEqual(parsePackageLines(answer.packages, RUST_UNITS.nameKey).map(p => [p.root, p.name, p.codeLines, p.sigLines, p.deps]), [
    ['crates/core', 'demo_core', 120, 7, ['serde']],
    ['crates/net', 'demo_net', 45, 3, ['demo_core', 'tokio']],
  ])
})

test('collectUnits: the commands it runs, the diff revisions passed through with `--` after them', () => {
  const io = fakeIo()
  collectUnits(['main...HEAD'], io)
  assert.deepEqual(io.calls.map(c => c.join(' ')), [
    'git rev-parse --show-toplevel',
    'cargo metadata --format-version 1 --no-deps',
    'git -C /w ls-files -z',
    'git -C /w grep -I -c -z -E ^[[:space:]]*pub[[:space:](]',
    'git diff --numstat --no-renames main...HEAD --',
  ])
})

test('collectUnits: no public line anywhere (git grep exits 1) is zero, not a failure', () => {
  const answer = collectUnits(['HEAD'], fakeIo({ grep: Object.assign(new Error('exit 1'), { status: 1, stderr: '' }) }))
  assert.equal(answer.error, undefined)
  assert.deepEqual(answer.packages, ['@@ crates/core 120 0 demo-core serde', '@@ crates/net 45 0 demo-net demo-core tokio'])
})

test('collectUnits: each failure is `{ roots: [], error }` saying what failed', () => {
  const enoent = Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' })
  const noManifest = Object.assign(new Error('Command failed'), { status: 101, stderr: 'error: could not find `Cargo.toml` in `/w` or any parent directory\n' })
  for (const [io, want] of /** @type {const} */ ([
    [fakeIo({ cargo: enoent }), 'cargo metadata: not found on PATH'],
    [fakeIo({ cargo: noManifest }), 'cargo metadata failed: error: could not find `Cargo.toml` in `/w` or any parent directory'],
    [fakeIo({ cargo: 'not json' }), 'cargo metadata printed no JSON'],
    [fakeIo({ diff: Object.assign(new Error('Command failed: git diff'), { status: 128, stderr: '' }) }), 'git diff failed: Command failed: git diff'],
    [fakeIo({ grep: Object.assign(new Error('x'), { status: 2, stderr: 'fatal: bad\n' }) }), 'git grep failed: fatal: bad'],
  ])) assert.deepEqual(collectUnits(['HEAD'], io), { roots: [], error: want })
})

test('the range: `--merge-base` and revisions only, so no other git diff option rides in', () => {
  assert.equal(badRange(['--merge-base', 'main']), '')
  assert.equal(badRange(['HEAD']), '')
  assert.equal(badRange([]), 'no revision given')
  assert.equal(badRange(['--merge-base']), 'no revision given')
  assert.equal(badRange(['--merge-base', '--output=/tmp/x']), 'not a revision: "--output=/tmp/x"')
  assert.equal(badRange(['main', '']), 'not a revision: ""')
  const io = fakeIo()
  assert.match(String(collectUnits(['--output=/tmp/x'], io).error), /^usage: craft-units/)
  assert.equal(io.calls.length, 0, 'nothing runs')
})

test('run: one JSON line, exit 0 with an answer, exit 1 with an error', async () => {
  const bad = await run(['--output=x'])
  assert.equal(bad.exitCode, 1)
  assert.equal(bad.stdout.length, 1)
  assert.match(String(JSON.parse(String(bad.stdout[0])).error), /not a revision/)
})

test('unitsAnswer: roots in package order', () => {
  assert.deepEqual(unitsAnswer([{ dir: 'a', name: 'a', deps: [] }], new Map(), new Map(), ''), { roots: ['a'], packages: ['@@ a 0 0 a'], numstat: [] })
})
