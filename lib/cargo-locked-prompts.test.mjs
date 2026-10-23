// The `cargo metadata`, `cargo tree` and `cargo fetch` calls that the engines, the review skills and
// agents and the OpenCode delivery tell an agent to run on the checkout under review leave its
// Cargo.lock alone: `--locked`, or `--no-deps` for `cargo metadata`, which does not resolve at all.
// A plain call rewrites a stale or missing lockfile and then reports a newly resolved version instead
// of the pinned one. Only the throwaway copy of a checkout with no Cargo.lock may resolve unlocked.
// Other cargo commands (build, test, clippy, …) are not checked here.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// A backtick escaped inside an engine's template literal reads as a plain one.
/** @param {string} rel */
const read = rel => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replaceAll('\\`', '`')

/** @param {string} dir @param {RegExp} ext */
const listed = (dir, ext) => fs.readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))).filter(f => ext.test(f) && !f.endsWith('.test.ts')).map(f => `${dir}/${f}`)

const FILES = [
  'src/review.js', 'src/rust-audit.js', 'src/adversarial-review.js', 'src/triage-findings.js',
  'lib/dependency-source.mjs',
  'skills/rust-review/SKILL.md', 'skills/rust-architecture-review/SKILL.md', 'skills/rust-ml/SKILL.md',
  'skills/rust-ml/frameworks.md', 'agents/rust-architecture-reviewer.md',
  ...listed('opencode/plugin', /\.ts$/), ...listed('opencode/agents', /\.md$/), ...listed('opencode/commands', /\.md$/),
]

// A bare code span is an instruction when a verb or preposition hands it to the agent ("run
// `cargo metadata`", "build on `cargo metadata`", "(from `cargo metadata`)"); otherwise it names
// the tool ("`cargo metadata` is unavailable").
const INSTRUCTED_BARE = /\b(?:run|use|using|via|from|on|resolve[sd]?)\s+\(?`cargo (?:metadata|tree|fetch)`/gi

/** @param {string} text @param {string} rel */
function unlockedCalls(text, rel) {
  const out = []
  for (const m of text.matchAll(/cargo (metadata|tree|fetch)\b([^`'\n;|&)]*)/g)) {
    const flags = String(m[2])
    if (!/^\s*-/.test(flags)) continue
    if (/--locked\b/.test(flags) || (m[1] === 'metadata' && /--no-deps\b/.test(flags))) continue
    if (/throwaway copy/.test(text.slice(Math.max(0, (m.index ?? 0) - 200), m.index))) continue
    out.push(`${rel}: ${m[0].trim()}`)
  }
  for (const m of text.matchAll(INSTRUCTED_BARE)) out.push(`${rel}: ${m[0]}`)
  return out
}

test('the checker catches a flagged unlocked call and a bare instructed one, not a named tool', () => {
  assert.deepEqual(unlockedCalls('Run `cargo tree -d` here', 'x'), ['x: cargo tree -d'])
  assert.deepEqual(unlockedCalls('build on `cargo metadata`.', 'x'), ['x: on `cargo metadata`'])
  assert.deepEqual(unlockedCalls('if `cargo metadata` is unavailable; run `cargo metadata --locked --format-version 1`', 'x'), [])
})

test('no metadata/tree/fetch call in the engines, review skills or OpenCode delivery runs unlocked on the reviewed checkout', () => {
  assert.ok(FILES.includes('opencode/plugin/rust-audit.ts') && FILES.includes('opencode/agents/rust-architecture-reviewer.md'))
  assert.deepEqual(FILES.flatMap(rel => unlockedCalls(read(rel), rel)), [])
})

test('rust-audit: the graph is read locked, and falls back to --no-deps, never to an unlocked call', () => {
  const src = read('src/rust-audit.js')
  const edges = /** @type {string} */ (/7\. edges = [^\n]*/.exec(src)?.[0])
  assert.match(edges, /`cargo metadata --locked --format-version 1`/)
  assert.match(edges, /`--locked` refuses[^\n]*`cargo metadata --no-deps --format-version 1`/)
  const orphans = /** @type {string} */ (/\(a\) ORPHAN workspace members[^\n]*/.exec(src)?.[0])
  assert.match(orphans, /`cargo metadata --locked --format-version 1`/)
  assert.match(orphans, /`--locked` refuses[^\n]*`cargo metadata --no-deps --format-version 1`/)
})

test('OpenCode rust-audit: the same locked graph and the --no-deps fallback', () => {
  const ts = read('opencode/plugin/rust-audit.ts')
  assert.match(ts, /`cargo metadata --locked --format-version 1`[^\n]*`--locked` refuses[^\n]*`cargo metadata --no-deps --format-version 1`/)
  assert.match(ts, /`cargo tree -d --locked`/)
})
