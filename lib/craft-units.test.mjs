// The units CLI (lib/craft-units.mjs) and its pure half (lib/cargo-units.mjs; realm @nick/craft, #377): the
// prose unit probe of lib/rust-units.mjs ported to Node. The equivalence test runs the prose commands
// themselves (bash, git, awk) and the CLI on one fixture repository and compares what they print.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { countLines, dirnameOf, hasPackageSection, manifestLine, readLines, rsPaths, unitsAnswer } from './cargo-units.mjs'
import { badRange, collectUnits, run } from './craft-units.mjs'
import { parseNumstat } from './unit-graph.mjs'
import { UNITS_SCHEMA } from './review-unit-schemas.mjs'
import { RUST_UNITS } from './rust-units.mjs'

/** A package line with its dependencies sorted: awk prints them in its own hash order. @param {string} line */
const sortedDeps = line => {
  const f = line.split(' ')
  return [...f.slice(0, 5), ...f.slice(5).sort()].join(' ')
}

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

test('unitsAnswer: roots are the directories, numstat lines verbatim with a binary file as `-\\t-\\t<path>`', () => {
  const answer = unitsAnswer([{ dir: 'a', line: '@@ a 3 1 a' }], '3\t1\ta/src/lib.rs\n-\t-\tassets/logo.png\n')
  assert.deepEqual(answer, { roots: ['a'], packages: ['@@ a 3 1 a'], numstat: ['3\t1\ta/src/lib.rs', '-\t-\tassets/logo.png'] })
  assert.deepEqual([...parseNumstat(answer.numstat)], [['a/src/lib.rs', 4], ['assets/logo.png', 0]])
  assert.deepEqual(Object.keys(answer).filter(k => !(k in /** @type {Record<string, unknown>} */ (UNITS_SCHEMA['properties']))), [])
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

// The fixture: a workspace that is not at the repository root (ws/, itself a package, with a member under it),
// a [package] outside any workspace (tools/gen), a virtual manifest (docs/), a .rs file with no final newline,
// a binary file with a `pub ` line in it, and a second commit whose diff holds a binary file.
const FIXTURE = {
  'ws/Cargo.toml': '[workspace]\nmembers = ["core"]\n[workspace.dependencies]\nserde = "1"\n\n[package]\nname = "ws-app"\n[dependencies]\nws-core = { path = "core" }\nserde.workspace = true\n',
  'ws/src/main.rs': 'pub fn main() {}\nfn x() {}\n',
  'ws/core/Cargo.toml': '[package]\nname = "ws-core"\n\n[dependencies.alias]\npackage = "anyhow"\nversion = "1"\n[dev-dependencies]\nproptest = "1"\n',
  'ws/core/src/lib.rs': 'pub(crate) mod a;\n  pub struct S;\nfn private() {}',
  'tools/gen/Cargo.toml': '[package]\nname = "gen"\n[build-dependencies]\ncc = "1"\n',
  'tools/gen/src/main.rs': 'fn main() {}\n',
  'docs/Cargo.toml': '[workspace]\nmembers = []\n',
  'ws/core/blob.bin': Buffer.from('pub x\n\0\x01\x02', 'binary'),
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** The fixture repository, two commits. @returns {string} */
function fixtureRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-units-')))
  git(['init', '-q', '-b', 'main'], repo)
  for (const [f, body] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true })
    fs.writeFileSync(path.join(repo, f), body)
  }
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  fs.appendFileSync(path.join(repo, 'ws/src/main.rs'), 'pub fn y() {}\n')
  fs.writeFileSync(path.join(repo, 'ws/core/blob.bin'), Buffer.from('pub y\n\0\x03', 'binary'))
  git(['commit', '-q', '-am', 'b'], repo)
  return repo
}

test('equivalence: on a nested workspace and a non-member package the CLI prints what the prose commands print', () => {
  const repo = fixtureRepo()
  try {
    const packagesCmd = String(/1\. Packages: `(.*)`\n/.exec(RUST_UNITS.probePrompt('HEAD~1..HEAD'))?.[1])
    const prose = execFileSync('bash', ['-c', packagesCmd], { cwd: repo, encoding: 'utf8' })
    const numstat = execFileSync('git', ['diff', '--numstat', '--no-renames', 'HEAD~1..HEAD'], { cwd: repo, encoding: 'utf8' })
    const cli = collectUnits(['HEAD~1..HEAD'], { cwd: repo })
    assert.equal(cli.error, undefined)
    assert.deepEqual(cli.packages?.map(sortedDeps), prose.trim().split('\n').map(sortedDeps), 'the prose lines, dependencies in either order')
    assert.deepEqual(cli.packages, ['@@ tools/gen 1 0 gen cc', '@@ ws 5 5 ws-app ws-core serde', '@@ ws/core 2 3 ws-core anyhow proptest'],
      'pinned: the nested member counted in its parent too, the binary file\'s match as one line, the virtual manifest skipped')
    assert.deepEqual(cli.roots, ['tools/gen', 'ws', 'ws/core'])
    assert.deepEqual(cli.numstat, numstat.trim().split('\n'))
    assert.ok(cli.numstat?.includes('-\t-\tws/core/blob.bin'))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
