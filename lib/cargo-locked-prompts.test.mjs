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
import { DEPENDENCY_SOURCE_HOW } from './dependency-source.mjs'

// A backtick escaped inside an engine's template literal reads as a plain one.
/** @param {string} rel */
const read = rel => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replaceAll('\\`', '`')

/** @param {string} dir @param {RegExp} ext */
const listed = (dir, ext) => fs.readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))).filter(f => ext.test(f) && !f.endsWith('.test.ts')).map(f => `${dir}/${f}`)

const FILES = [
  'src/review.js', 'src/rust-audit.js', 'src/adversarial-review.js', 'src/triage-findings.js',
  'lib/dependency-source.mjs',
  'skills/rust-review/SKILL.md', 'skills/rust-architecture-review/SKILL.md', 'skills/rust-ml/SKILL.md',
  'skills/rust-ml/frameworks.md', 'skills/rust-ecosystem/SKILL.md', 'skills/rust-ecosystem/cargo.md',
  'agents/rust-architecture-reviewer.md',
  ...listed('opencode/plugin', /\.ts$/), ...listed('opencode/agents', /\.md$/), ...listed('opencode/commands', /\.md$/),
]

// A bare code span is an instruction when a verb or preposition hands it to the agent ("run
// `cargo metadata`", "build on `cargo metadata`", "(from `cargo metadata`)"); otherwise it names
// the tool ("`cargo metadata` is unavailable").
const INSTRUCTED_BARE = /\b(?:run|use|using|via|from|on|resolve[sd]?)\s+\(?`cargo (?:metadata|tree|fetch)`/gi
// Inside a fenced code block every line is a command, flags or none.
const FENCED_CALL = /^\s*cargo (metadata|tree|fetch)\b(.*)$/gm
// The one unlocked call allowed: DEPENDENCY_SOURCE_HOW's throwaway copy of a checkout with no Cargo.lock.
const THROWAWAY_CLAUSE = 'resolve in a throwaway copy'
const THROWAWAY_CALL = 'run `cargo metadata --format-version 1` there'

/** @param {string} flags @param {string} cmd */
const locked = (flags, cmd) => /--locked\b/.test(flags) || (cmd === 'metadata' && /--no-deps\b/.test(flags))

/** The start of the throwaway call inside the clause, when this text carries the clause. @param {string} text */
function throwawayAt(text) {
  const clause = text.indexOf(THROWAWAY_CLAUSE)
  const call = text.indexOf(THROWAWAY_CALL, clause)
  return clause < 0 || call < 0 ? -1 : call + 'run `'.length
}

/** @param {string} text @param {string} rel */
function unlockedCalls(text, rel) {
  const out = []
  const exempt = throwawayAt(text)
  for (const m of text.matchAll(/cargo (metadata|tree|fetch)\b([^`'\n;|&)]*)/g)) {
    const flags = String(m[2])
    if (!/^\s*-/.test(flags) || locked(flags, String(m[1])) || m.index === exempt) continue
    out.push(`${rel}: ${m[0].trim()}`)
  }
  for (const m of text.matchAll(INSTRUCTED_BARE)) out.push(`${rel}: ${m[0]}`)
  return [...out, ...fencedFlagless(text).map(c => `${rel}: ${c}`)]
}

/** Flagless calls on their own line in a fenced code block (flagged ones are caught above). @param {string} text */
function fencedFlagless(text) {
  const blocks = text.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? []
  return blocks.flatMap(block => [...block.matchAll(FENCED_CALL)])
    .filter(m => !/^\s*-/.test(String(m[2])) && !locked(String(m[2]), String(m[1])))
    .map(m => m[0].trim())
}

test('the checker catches a flagged unlocked call and a bare instructed one, not a named tool', () => {
  assert.deepEqual(unlockedCalls('Run `cargo tree -d` here', 'x'), ['x: cargo tree -d'])
  assert.deepEqual(unlockedCalls('build on `cargo metadata`.', 'x'), ['x: on `cargo metadata`'])
  assert.deepEqual(unlockedCalls('if `cargo metadata` is unavailable; run `cargo metadata --locked --format-version 1`', 'x'), [])
  assert.deepEqual(unlockedCalls('```bash\ncargo tree            # inspect\ncargo tree --locked\n```', 'x'), ['x: cargo tree            # inspect'])
})

test('only the exact throwaway-copy clause of DEPENDENCY_SOURCE_HOW may resolve unlocked', () => {
  assert.ok(DEPENDENCY_SOURCE_HOW.includes(THROWAWAY_CLAUSE) && DEPENDENCY_SOURCE_HOW.includes(THROWAWAY_CALL))
  assert.deepEqual(unlockedCalls(DEPENDENCY_SOURCE_HOW, 'x'), [])
  assert.deepEqual(unlockedCalls('in a throwaway copy, then run `cargo metadata --format-version 1` here', 'x'), ['x: cargo metadata --format-version 1'])
  assert.deepEqual(unlockedCalls(`${DEPENDENCY_SOURCE_HOW} Also run \`cargo fetch --verbose\`.`, 'x'), ['x: cargo fetch --verbose'])
})

// Exempt, by name and count — not a hole: rust-audit's dependency-hygiene dimension runs a plain
// `cargo tree -d`. Locking it alone protects nothing while its sibling dimensions (build matrix, the
// nested review gate, test coverage) run unlocked build/test commands in parallel, and `--locked`
// fails outright on a library with no committed Cargo.lock. It waits for the owner's pending
// decision on the gate's build/test commands; a new unlocked call anywhere still fails this test.
const PENDING_GATE_DECISION = [
  'src/rust-audit.js: cargo tree -d',
  'src/rust-audit.js: cargo tree -d',
  'opencode/plugin/rust-audit.ts: cargo tree -d',
]

test('no metadata/tree/fetch call in the engines, review skills or OpenCode delivery runs unlocked on the reviewed checkout', () => {
  assert.ok(FILES.includes('opencode/plugin/rust-audit.ts') && FILES.includes('opencode/agents/rust-architecture-reviewer.md'))
  assert.deepEqual(FILES.flatMap(rel => unlockedCalls(read(rel), rel)), PENDING_GATE_DECISION)
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
})

test('rust-audit deps dimension, both deliveries: unchanged until the gate decision — no --locked, no refusal path', () => {
  for (const rel of ['src/rust-audit.js', 'opencode/plugin/rust-audit.ts']) {
    const hygiene = /** @type {string} */ (/Audit dependency HYGIENE[^\n]*/.exec(read(rel))?.[0])
    assert.match(hygiene, /`cargo tree -d` \(duplicate/, rel)
    assert.doesNotMatch(hygiene, /--locked|duplicates not inspected/, rel)
  }
})
