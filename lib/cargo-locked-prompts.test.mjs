// Every cargo call that resolves dependencies, as the engines and the review skills tell an agent to
// run it on the checkout under review, refuses to touch Cargo.lock: `--locked`, or `--no-deps` for
// `cargo metadata`, which does not resolve at all. A plain call rewrites a stale or missing lockfile
// and then reports a newly resolved version instead of the pinned one.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// A backtick escaped inside an engine's template literal reads as a plain one.
/** @param {string} rel */
const read = rel => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').replaceAll('\\`', '`')

const FILES = [
  'src/review.js', 'src/rust-audit.js', 'src/adversarial-review.js', 'src/triage-findings.js',
  'lib/dependency-source.mjs',
  'skills/rust-review/SKILL.md', 'skills/rust-architecture-review/SKILL.md', 'skills/rust-ml/SKILL.md',
  'skills/rust-ml/frameworks.md', 'agents/rust-architecture-reviewer.md',
]

test('no resolving cargo call in the engines or the review skills runs unlocked', () => {
  const unlocked = []
  for (const rel of FILES) {
    // An invocation: the command and its flags, up to the end of the code span or shell word run.
    for (const m of read(rel).matchAll(/cargo (metadata|tree|fetch)\b([^`'\n;|&)]*)/g)) {
      const flags = String(m[2])
      const bareNoun = !/^\s*-/.test(flags)
      if (bareNoun) continue
      if (!/--locked\b/.test(flags) && !(m[1] === 'metadata' && /--no-deps\b/.test(flags))) unlocked.push(`${rel}: ${m[0].trim()}`)
    }
  }
  assert.deepEqual(unlocked, [])
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
