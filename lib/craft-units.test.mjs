// The units CLI (lib/craft-units.mjs) and its pure half (lib/cargo-units.mjs; realm @nick/craft, #377): the
// prose unit probe of lib/rust-units.mjs ported to Node. The equivalence test runs the prose commands
// themselves (bash, git, awk) and the CLI on one fixture repository and compares what they print.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { countLines, dirnameOf, hasPackageSection, manifestLine, readLines, rsPaths } from './cargo-units.mjs'
import { badRange, collectUnits, run } from './craft-units.mjs'

test('the awk port: name, dependency keys and renames in every dependencies section, never [workspace.*]', () => {
  const manifest = [
    '[workspace]', 'members = ["a"]', '[workspace.dependencies]', 'tokio = "1"',
    '[package]', 'name = "demo-net" # the crate', 'version = "0.1.0"',
    '[dependencies]', 'serde = { version = "1", features = ["derive"] }', 'core = { path = "../core", package = "demo-core" }', 'tokio.workspace = true',
    '[dev-dependencies]', 'proptest = "1"',
    "[target.'cfg(unix)'.dependencies]", 'nix = "0.29"',
    '[dependencies.renamed-key]', 'package = "real-name"', 'version = "2"',
    '[build-dependencies.cc]', 'version = "1"',
    '[features]', 'default = []',
  ].join('\n')
  assert.equal(manifestLine('crates/net', 10, 2, manifest), '@@ crates/net 10 2 demo-net serde demo-core tokio proptest nix real-name cc')
})

test('the awk port: a header with a trailing comment, a missing name, CRLF lines', () => {
  assert.equal(manifestLine('.', 0, 0, '[package]\nname = "a"\n[dependencies] # x\nserde = "1"\n'), '@@ . 0 0 a', '`[dependencies]#x` does not end with `dependencies]`')
  assert.equal(manifestLine('d', 1, 1, '[dependencies]\nserde = "1"\n'), '@@ d 1 1  serde', 'awk prints the empty name between two spaces')
  assert.equal(manifestLine('d', 0, 0, '[package]\r\nname = "w"\r\n[dependencies]\r\nserde = "1"\r\n'), '@@ d 0 0 w serde', 'the header\'s \\r is whitespace awk removes')
})

test('the shell steps: [package] at a line start, read -r trimming, dirname, the .rs filter, wc -l', () => {
  assert.equal(hasPackageSection('[workspace]\n[package]\nname="a"'), true)
  assert.equal(hasPackageSection(' [package]\n'), false, 'grep \'^\\[package\\]\' wants it at the line start')
  assert.deepEqual(readLines('Cargo.toml\n  a/Cargo.toml \n\n'), ['Cargo.toml', 'a/Cargo.toml'])
  assert.deepEqual(['Cargo.toml', 'a/b/Cargo.toml', '/Cargo.toml', 'a//Cargo.toml'].map(dirnameOf), ['.', 'a/b', '/', 'a'])
  assert.deepEqual(rsPaths('a.rs\nb.rsx\nc/d.rs\n'), ['a.rs', 'c/d.rs'])
  assert.equal(countLines('a\nb'), 1, 'a last line without a newline is not counted, as wc -l does not')
})

test('the range: `--merge-base` and revisions only, so no other git diff option rides in', () => {
  assert.equal(badRange(['--merge-base', 'main']), '')
  assert.equal(badRange(['HEAD']), '')
  assert.equal(badRange([]), 'no revision given')
  assert.equal(badRange(['--merge-base']), 'no revision given')
  assert.equal(badRange(['--merge-base', '--output=/tmp/x']), 'not a revision: "--output=/tmp/x"')
  assert.equal(badRange(['main', '']), 'not a revision: ""')
  /** @type {string[][]} */
  const calls = []
  assert.match(String(collectUnits(['--output=/tmp/x'], { exec: (c, a) => { calls.push([c, ...a]); return '' } }).error), /^usage: craft-units/)
  assert.deepEqual(calls, [], 'nothing runs')
})

test('collectUnits: a failed git command is `{ roots: [], error }` saying what failed; no public line is zero', () => {
  const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(collectUnits(['HEAD'], { exec: () => { throw enoent } }), { roots: [], error: 'git ls-files: not found on PATH' })
  const notRepo = Object.assign(new Error('Command failed'), { status: 128, stderr: 'fatal: not a git repository\n' })
  assert.deepEqual(collectUnits(['HEAD'], { exec: () => { throw notRepo } }), { roots: [], error: 'git ls-files failed: fatal: not a git repository' })
  /** @param {string} _cmd @param {string[]} args */
  const exec = (_cmd, args) => {
    if (args[0] === 'grep') throw Object.assign(new Error('exit 1'), { status: 1, stderr: '' })
    if (args[0] === 'diff') return '1\t0\tsrc/lib.rs\n'
    return args.includes('Cargo.toml') ? 'Cargo.toml\nmissing/Cargo.toml\n' : 'src/lib.rs\ngone.rs\n'
  }
  /** @param {string} f */
  const readFile = f => {
    if (f === 'Cargo.toml') return '[package]\nname = "a"\n'
    if (f === 'src/lib.rs') return 'x\ny\n'
    throw new Error('ENOENT')
  }
  assert.deepEqual(collectUnits(['HEAD'], { exec, readFile }), { roots: ['.'], packages: ['@@ . 2 0 a'], numstat: ['1\t0\tsrc/lib.rs'] }, 'an unreadable manifest is skipped, an unreadable .rs file has no lines')
})

test('run: one JSON line, exit 1 with an error', async () => {
  const bad = await run(['--output=x'])
  assert.equal(bad.exitCode, 1)
  assert.match(String(JSON.parse(String(bad.stdout[0])).error), /not a revision/)
})
