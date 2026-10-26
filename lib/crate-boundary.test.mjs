// lib/crate-boundary.mjs over fixture transcripts laid out as a Workflow run directory: what a confined lens
// read outside its crate is counted from its tool calls, never from what it said it did.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { confinedLensOf, bashTouches, shellSegments, runBoundary, formatBoundary, main } from './crate-boundary.mjs'

const REPO = '/work/repo'

/** @param {string} name @param {unknown} input */
const use = (name, input) => ({ type: 'tool_use', id: `t-${name}`, name, input })
/** @param {Array<ReturnType<typeof use>>} uses */
function transcript(uses) {
  return [
    { type: 'user', cwd: REPO, message: { role: 'user', content: 'task' } },
    ...uses.map(u => ({ type: 'assistant', cwd: REPO, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, u] } })),
    { type: 'user', cwd: REPO, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    '{not json',
  ].map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')
}

/** @param {Record<string, { label: string, uses: Array<ReturnType<typeof use>> }>} agents */
function runDir(agents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-boundary-'))
  for (const [id, a] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), transcript(a.uses))
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'rust-reviewer', description: a.label }))
  }
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), '')
  return dir
}

test('confinedLensOf reads the crate root out of a confined lens label, and nothing else', () => {
  assert.deepEqual(confinedLensOf('lens:rust:safety r1 crate:crates/a'), { lens: 'safety', root: 'crates/a' })
  assert.deepEqual(confinedLensOf('lens:rust:errors r2 crate:crates/a//src/m1'), { lens: 'errors', root: 'crates/a' })
  assert.deepEqual(confinedLensOf('lens:rust:errors resurrect1 crate:.//src'), { lens: 'errors', root: '.' })
  assert.equal(confinedLensOf('lens:rust:contract r1 crate:crates/a'), null, 'the contract lens reads call sites by design')
  assert.equal(confinedLensOf('lens:rust:safety r1 bin/x'), null, 'a directory slice is not confined')
  assert.equal(confinedLensOf('coord:rust r1'), null)
  assert.equal(confinedLensOf(undefined), null)
})

test('shellSegments splits on operators and keeps quoted words whole', () => {
  assert.deepEqual(shellSegments(`cd /r && grep -n 'a b' x.rs | head -5; cat "y z.rs"`), [['cd', '/r'], ['grep', '-n', 'a b', 'x.rs'], ['head', '-5'], ['cat', 'y z.rs']])
})

test('bashTouches follows cd, skips a search pattern and a sed script, and marks context searches', () => {
  const { touches } = bashTouches(`cd ${REPO} && sed -n '1,40p' crates/b/src/lib.rs && grep -rn -C 3 foo crates/c && git grep -n 'pub fn' -- crates/d && rg bar`, '/elsewhere')
  assert.deepEqual(touches.map(t => [t.tool, t.kind, path.relative(REPO, t.path) || '.']), [
    ['Bash:sed', 'read', 'crates/b/src/lib.rs'],
    ['Bash:grep', 'body-search', 'crates/c'],
    ['Bash:grep', 'search', 'crates/d'],
    ['Bash:rg', 'search', '.'],
  ])
})

test('runBoundary counts body reads outside the crate as violations, and lists the rest apart', () => {
  const dir = runDir({
    a1: { label: 'lens:rust:safety r1 crate:crates/a', uses: [
      use('Read', { file_path: `${REPO}/crates/a/src/lib.rs` }),
      use('Read', { file_path: `${REPO}/crates/b/src/lib.rs` }),
      use('Grep', { pattern: 'fn x', path: 'crates/c', output_mode: 'content', '-C': 5 }),
      use('Grep', { pattern: 'pub fn', path: 'crates/d' }),
      use('Glob', { pattern: '**/*.rs' }),
      use('Read', { file_path: `${REPO}/crates/b/Cargo.toml` }),
      use('Read', { file_path: '/home/u/.cargo/registry/src/x/lib.rs' }),
      use('Bash', { command: `git diff --merge-base origin/main -- 'crates/a/src/lib.rs' 'Cargo.lock'` }),
    ] },
    a2: { label: 'lens:rust:errors r1 crate:crates/b//src/m', uses: [use('Read', { file_path: `${REPO}/crates/b/src/m/x.rs` })] },
    c1: { label: 'coord:rust r1', uses: [use('Read', { file_path: `${REPO}/crates/z/src/lib.rs` })] },
    k1: { label: 'lens:rust:contract r1 crate:crates/a', uses: [use('Read', { file_path: `${REPO}/crates/z/src/lib.rs` })] },
  })
  const r = runBoundary(dir, { repo: REPO })
  assert.deepEqual(r.summary, { confinedAgents: 2, agentsWithViolations: 1, violations: 2 })
  const a1 = r.agents.find(a => a.agent === 'a1')
  assert.ok(a1)
  assert.deepEqual(a1.violations, [{ tool: 'Read', path: 'crates/b/src/lib.rs' }, { tool: 'Grep', path: 'crates/c' }])
  assert.deepEqual(a1.searches, [{ tool: 'Grep', path: 'crates/d' }])
  assert.deepEqual(a1.lists, [{ tool: 'Glob', path: '.' }])
  assert.deepEqual(a1.manifests, [{ tool: 'Read', path: 'crates/b/Cargo.toml' }])
  assert.deepEqual(a1.outsideRepo, [{ tool: 'Read', path: '/home/u/.cargo/registry/src/x/lib.rs' }])
  const text = formatBoundary(r)
  assert.match(text, /VIOLATION Read crates\/b\/src\/lib\.rs/)
  assert.doesNotMatch(text, /crates\/z/, 'the coordinator and the contract lens are not confined lenses')
  // The CLI's two forms; the repository root defaults to the transcript's own cwd.
  assert.equal(JSON.parse(main([dir, '--json'])).summary.violations, 2)
  assert.match(main([dir, '--repo', REPO]), /with body reads outside their crate: 1/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a transcript without its meta is skipped; no run directory is an error', () => {
  const dir = runDir({ a1: { label: 'lens:rust:safety r1 crate:crates/a', uses: [use('Read', { file_path: `${REPO}/crates/b/x.rs` })] } })
  fs.rmSync(path.join(dir, 'agent-a1.meta.json'))
  assert.equal(runBoundary(dir).summary.confinedAgents, 0)
  fs.rmSync(dir, { recursive: true, force: true })
  assert.throws(() => main([]), /usage/)
  assert.throws(() => main([path.join(os.tmpdir(), 'no-such-run-dir-xyz')]))
})
