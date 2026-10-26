// lib/crate-boundary.mjs over fixture transcripts laid out as a Workflow run directory: what a confined lens
// read outside its crate is counted from its tool calls, never from what it said it did.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { confinedLensOf, runBoundary, formatBoundary, main } from './crate-boundary.mjs'
import { bashTouches, pipedSegments } from './shell-touches.mjs'

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
  assert.deepEqual(confinedLensOf('lens:rust:safety r1 crate:crates/a'), { lens: 'safety', root: 'crates/a', roots: ['crates/a'] })
  assert.deepEqual(confinedLensOf('lens:rust:errors r2 crate:crates/a//src/m1'), { lens: 'errors', root: 'crates/a', roots: ['crates/a'] })
  assert.deepEqual(confinedLensOf('lens:rust:errors resurrect1 crate:.//src'), { lens: 'errors', root: '.', roots: ['.'] })
  assert.deepEqual(confinedLensOf('lens:rust:safety+errors r1 crate:crates/a crate:crates/b'), { lens: 'safety+errors', root: 'crates/a', roots: ['crates/a', 'crates/b'] }, 'a batch is one boundary')
  assert.equal(confinedLensOf('lens:rust:safety r1 bin/x'), null, 'a directory slice is not confined')
  assert.equal(confinedLensOf('coord:rust r1'), null)
  assert.equal(confinedLensOf(undefined), null)
})

test('pipedSegments splits on operators, keeps quoted words whole and marks what a pipe feeds', () => {
  assert.deepEqual(pipedSegments(`cd /r && grep -n 'a b' x.rs | head -5; cat "y z.rs"`).map(s => [s.piped, s.words]), [[false, ['cd', '/r']], [false, ['grep', '-n', 'a b', 'x.rs']], [true, ['head', '-5']], [false, ['cat', 'y z.rs']]])
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
  assert.deepEqual(r.summary, { confinedAgents: 2, agentsWithViolations: 1, violations: 2, contractAgents: 1, contractAgentsWithBodyReads: 1, contractBodyReads: 1, unattributedReads: 0 })
  const a1 = r.agents.find(a => a.agent === 'a1')
  assert.ok(a1)
  assert.deepEqual(a1.violations, [{ tool: 'Read', path: 'crates/b/src/lib.rs' }, { tool: 'Grep', path: 'crates/c' }])
  assert.deepEqual(a1.searches, [{ tool: 'Grep', path: 'crates/d' }])
  assert.deepEqual(a1.lists, [{ tool: 'Glob', path: '.' }])
  assert.deepEqual(a1.manifests, [{ tool: 'Read', path: 'crates/b/Cargo.toml' }])
  assert.deepEqual(a1.outsideRepo, [{ tool: 'Read', path: '/home/u/.cargo/registry/src/x/lib.rs' }])
  const text = formatBoundary(r)
  assert.match(text, /VIOLATION Read crates\/b\/src\/lib\.rs/)
  assert.doesNotMatch(text, /VIOLATION Read crates\/z/, 'the coordinator is not a confined lens; the contract lens is counted apart')
  assert.match(text, /BODY READ Read crates\/z\/src\/lib\.rs/)
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

test('an option value is never read as a path: head/tail -n, sed -n, grep -A/-m, awk -F, find -name', () => {
  const rel = (/** @type {string} */ cmd) => bashTouches(cmd, REPO).touches.map(t => [t.kind, path.relative(REPO, t.path) || '.'])
  assert.deepEqual(rel('head -n 50 crates/a/src/f0.rs'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('head -c 200 crates/a/src/f0.rs'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('tail -n +100 crates/a/src/f0.rs'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('tail --lines 5 crates/a/src/f0.rs'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('sed -n 1,80p crates/a/src/f0.rs'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel(`sed -n -e '1,8p' crates/a/src/f0.rs`), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('grep -A 3 foo crates/a'), [['body-search', 'crates/a']])
  assert.deepEqual(rel('grep -rn -m 5 foo crates/a'), [['search', 'crates/a']])
  assert.deepEqual(rel(`awk -F : '{print $1}' crates/a/x.txt`), [['read', 'crates/a/x.txt']])
  assert.deepEqual(rel(`find crates/a -name '*.rs' -maxdepth 2`), [['list', 'crates/a']])
  // Piped: the value of the reader downstream of a pipe is not a path either, and its input is stdin.
  assert.deepEqual(rel('cat crates/a/src/f0.rs | head -n 30'), [['read', 'crates/a/src/f0.rs']])
  assert.deepEqual(rel('grep -rn foo crates/a | head -20'), [['search', 'crates/a']])
})

test('git show <rev>:<path> and git cat-file -p <rev>:<path> are body reads of that path, from the repository root', () => {
  const rel = (/** @type {string} */ cmd, cwd = REPO) => bashTouches(cmd, cwd, REPO).touches.map(t => [t.tool, t.kind, path.relative(REPO, t.path) || '.'])
  assert.deepEqual(rel('git show HEAD:crates/b/src/lib.rs'), [['Bash:git show', 'read', 'crates/b/src/lib.rs']])
  assert.deepEqual(rel('git show origin/main:crates/b/src/lib.rs | head -n 40'), [['Bash:git show', 'read', 'crates/b/src/lib.rs']])
  assert.deepEqual(rel('git cat-file -p abc123:crates/b/src/lib.rs'), [['Bash:git cat-file', 'read', 'crates/b/src/lib.rs']])
  assert.deepEqual(rel('git cat-file blob HEAD:crates/b/src/lib.rs'), [['Bash:git cat-file', 'read', 'crates/b/src/lib.rs']])
  assert.deepEqual(rel('git -C /work/repo show :crates/b/src/lib.rs'), [['Bash:git show', 'read', 'crates/b/src/lib.rs']])
  // rev:path is root-relative wherever the agent stands; rev:./path is relative to where it stands.
  assert.deepEqual(rel('git show HEAD:crates/b/src/lib.rs', `${REPO}/crates/a`), [['Bash:git show', 'read', 'crates/b/src/lib.rs']])
  assert.deepEqual(rel('git show HEAD:./src/lib.rs', `${REPO}/crates/a`), [['Bash:git show', 'read', 'crates/a/src/lib.rs']])
  // A commit, a diff or a stat names no body.
  assert.deepEqual(rel('git show --stat HEAD'), [])
  assert.deepEqual(rel('git show HEAD -- crates/b'), [])
})

test('the contract lens is reported in its own bucket: body reads outside its crate, signature searches allowed', () => {
  assert.deepEqual(confinedLensOf('lens:rust:contract r1 crate:crates/a'), { lens: 'contract', root: 'crates/a', roots: ['crates/a'] })
  const dir = runDir({
    a1: { label: 'lens:rust:safety r1 crate:crates/a', uses: [use('Read', { file_path: `${REPO}/crates/b/src/lib.rs` })] },
    k1: { label: 'lens:rust:contract r1 crate:crates/a', uses: [
      use('Read', { file_path: `${REPO}/crates/a/src/lib.rs` }),
      use('Read', { file_path: `${REPO}/crates/z/src/lib.rs` }),
      use('Bash', { command: `git grep -n -E '^\\s*(pub|///)' -- crates/z` }),
    ] },
  })
  const r = runBoundary(dir, { repo: REPO })
  assert.deepEqual(r.summary, { confinedAgents: 1, agentsWithViolations: 1, violations: 1, contractAgents: 1, contractAgentsWithBodyReads: 1, contractBodyReads: 1, unattributedReads: 0 })
  const k1 = r.agents.find(a => a.agent === 'k1')
  assert.ok(k1)
  assert.equal(k1.lens, 'contract')
  assert.deepEqual(k1.violations, [{ tool: 'Read', path: 'crates/z/src/lib.rs' }])
  assert.deepEqual(k1.searches, [{ tool: 'Bash:grep', path: 'crates/z' }])
  const text = formatBoundary(r)
  assert.match(text, /contract lens agents: 1 · with body reads outside their crate: 1 · such reads: 1/)
  assert.match(text, /BODY READ Read crates\/z\/src\/lib\.rs/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a batch agent is bounded by all its crates: a body read in another crate of its batch is its own', () => {
  const dir = runDir({
    b1: { label: 'lens:rust:safety+errors r1 crate:crates/a crate:crates/b', uses: [
      use('Read', { file_path: `${REPO}/crates/b/src/lib.rs` }),
      use('Read', { file_path: `${REPO}/crates/c/src/lib.rs` }),
    ] },
  })
  const r = runBoundary(dir, { repo: REPO })
  assert.deepEqual(r.agents[0]?.violations, [{ tool: 'Read', path: 'crates/c/src/lib.rs' }])
  assert.match(formatBoundary(r), /\[crates crates\/a, crates\/b\]/)
})

test('a read xargs runs on paths nothing upstream names is listed as unattributed, apart from the violations', () => {
  const cmd = 'echo crates/z/src/lib.rs | xargs cat'
  const dir = runDir({
    u1: { label: 'lens:rust:safety r1 crate:crates/a', uses: [use('Bash', { command: cmd }), use('Bash', { command: 'git ls-files crates/z | xargs cat' })] },
  })
  const r = runBoundary(dir, { repo: REPO })
  assert.deepEqual(r.agents[0]?.unattributed, [{ tool: 'Bash:cat', path: cmd }])
  assert.deepEqual(r.agents[0]?.violations, [{ tool: 'Bash:cat', path: 'crates/z' }])
  assert.equal(r.summary.unattributedReads, 1)
  const text = formatBoundary(r)
  assert.match(text, /reads of paths no command named \(unattributed\): 1/)
  assert.match(text, /UNATTRIBUTED Bash:cat echo crates\/z\/src\/lib\.rs \| xargs cat/)
  fs.rmSync(dir, { recursive: true, force: true })
})
