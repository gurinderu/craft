// Launch names are checked by structure, and each real site is falsified on its own (realm @nick/craft, #83):
// the sites come from parsing the shipped engines and bodies, not from a list, and every one is broken
// alone and must turn red at its own line — one break per loop would let a site the check misses hide.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTypescript } from './run-tsc.mjs'
import { launchKnown, engineLaunchSites, launchProblems } from './launch-names.mjs'
import { proseLaunchSites } from './prose-launch-names.mjs'
import { run as checkSkills } from './check-skills.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = loadTypescript(ROOT)
if (!ts) throw new Error('typescript is not installed — run npm ci --prefix opencode/plugin')
const KNOWN = launchKnown(ROOT)
/** @param {string} src */
const sites = src => engineLaunchSites(/** @type {NonNullable<typeof ts>} */ (ts), src, KNOWN)
/** @param {string} src */
const problems = src => sites(src).filter(s => s.problem !== null)

const engines = fs.readdirSync(path.join(ROOT, 'workflows')).filter(f => f.endsWith('.js')).sort()
  .map(f => ({ f, src: fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8') }))
const proseFiles = [
  ...fs.readdirSync(path.join(ROOT, 'skills'), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.md')).map(f => `skills/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'agents')).filter(f => f.endsWith('.md')).map(f => `agents/${f}`),
].map(f => ({ f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }))

/** @param {string} src @param {number} start @param {number} end @param {string} text */
const splice = (src, start, end, text) => src.slice(0, start) + text + src.slice(end)

// The break that a site's own mistake looks like: the prefix dropped, or (for a launcher, which takes the
// bare name and qualifies it itself) the prefix written twice. A fallback launch is broken through the
// qualified launch it falls back from: without one before it, the bare launch is the whole launch.
/** @param {string} src @param {import('./launch-names.mjs').Site} s @returns {string} */
function breakSite(src, s) {
  if (s.kind === 'launcher') return splice(src, s.start, s.end, `'${KNOWN.plugin}:${s.text.slice(1, -1)}'`)
  if (s.text.includes(`${KNOWN.plugin}:`)) return splice(src, s.start, s.end, s.text.replace(`${KNOWN.plugin}:`, ''))
  const before = src.lastIndexOf(`\`${KNOWN.plugin}:\${`, s.start)
  assert.ok(before >= 0, `fallback ${s.text} at line ${s.line} has no qualified launch before it`)
  return splice(src, before + 1, before + 1 + KNOWN.plugin.length + 1, '')
}

test('the shipped engines launch only under the prefixed name, and every engine that launches is seen', () => {
  for (const { f, src } of engines) {
    assert.deepEqual(problems(src).map(s => s.problem), [], f)
    if (/\bworkflow\(|\bagentType\b/.test(src.replace(/\/\/.*$/gm, ''))) assert.ok(sites(src).length > 0, `${f} launches but no site was found`)
  }
  const all = engines.flatMap(({ f, src }) => sites(src).map(s => `${f}:${s.kind}`))
  for (const kind of ['workflow', 'launcher', 'agent']) assert.ok(all.some(x => x.endsWith(`:${kind}`)), `no ${kind} site in the tree`)
})

test('each engine launch site, broken alone, is red at its own line', () => {
  let n = 0
  for (const { f, src } of engines) {
    for (const s of sites(src)) {
      const red = problems(breakSite(src, s))
      assert.ok(red.some(r => r.line === s.line), `${f}:${s.line} (${s.kind} ${s.text}) broken stays green`)
      n++
    }
  }
  assert.ok(n >= 16, `only ${n} engine sites falsified`)
})

test('each prose launch name, unprefixed alone, is red at its own line', () => {
  let n = 0
  for (const { f, src } of proseFiles) {
    assert.deepEqual(proseLaunchSites(src, KNOWN).filter(s => s.problem).map(s => `${f}:${s.line}`), [])
    for (const s of proseLaunchSites(src, KNOWN)) {
      const broken = splice(src, s.start, s.end, s.text.replace(`${KNOWN.plugin}:`, ''))
      assert.ok(proseLaunchSites(broken, KNOWN).some(r => r.problem && r.line === s.line), `${f}:${s.line} ${s.text} broken stays green`)
      n++
    }
  }
  assert.ok(n >= 22, `only ${n} prose sites falsified`)
})

/** @param {string} body */
const wrap = body => `export const meta = { name: 'w' }\n${body}\n`

test('engine shapes: each way to launch by an unresolvable name is refused, each sound one passes', () => {
  /** @type {[string, boolean][]} */
  const cases = [
    ["return await workflow('review', {})", false],
    ["return await workflow('craft:review', {})", true],
    ["return await workflow('craft:nope', {})", false],
    ["return await workflow('other:review', {})", false],
    ['return await workflow(n, {})', false],
    ['return await workflow()', false],
    ['try { await workflow(`craft:${n}`) } catch { await workflow(n) }', true],
    ["try { await workflow('x') } catch { await workflow(n) }", false],
    ["await launch(workflow, 'review', {})", true],
    ["await launch(workflow, 'craft:review', {})", false],
    ['await launch(workflow, n, {})', false],
    ['await launch(workflow)', false],
    ["agent('p', { agentType: 'craft:rust-reviewer' })", true],
    ["agent('p', { agentType: 'rust-reviewer' })", false],
    ["agent('p', { agentType: 'craft:nobody' })", false],
    ["agent('p', { agentType: pick() })", false],
    ["agent('p', { agentType })", false],
    ["const p = { reviewerAgent: 'rust-reviewer' }", false],
    ["agent('p', { agentType: profile.reviewerAgent })", true],
    ["const p = { label: 'rust-reviewer' }", true],
    // `workflow` handed on by alias or inside an object is a launch the check cannot read: refused whatever it names.
    ["const wf = workflow; await wf('review', {})", false],
    ["const wf = workflow; await wf('craft:review', {})", false],
    ["let wf; wf = workflow", false],
    ["await launch({ workflow }, 'review')", false],
    ["await launch({ run: workflow }, 'review')", false],
    ["const o = { workflow: 1 }; o.workflow = 2; function f(workflow) { return workflow('craft:review') }", true],
  ]
  for (const [body, ok] of cases) assert.equal(problems(wrap(body)).length === 0, ok, body)
})

test('prose: only this plugin\'s ids followed by workflow/agent count, and another plugin\'s prefix is not ours', () => {
  const lines = [
    'run the `review` workflow', 'the `rust-miri` agent', 'the `craft:review` workflow', 'the `other:review` workflow',
    'the `review` lens', 'the `rust-testing` workflow', '`triage-findings`) workflows',
  ]
  assert.deepEqual(lines.map(l => proseLaunchSites(l, KNOWN).filter(s => s.problem).length), [1, 1, 0, 0, 0, 0, 1])
})

test('check-skills fails on a bare launch name in a skill body and in an agent, and passes once prefixed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ln-'))
  /** @param {string} rel @param {string} body */
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body) }
  try {
    put('.claude-plugin/plugin.json', JSON.stringify({ name: 'craft', version: '1.0.0' }))
    put('workflows/review.js', "export const meta = { name: 'review' }\n")
    put('skills/s/SKILL.md', '---\nname: s\ndescription: d\n---\nRun the `review` workflow.\n')
    put('agents/a.md', '---\nname: a\ndescription: d\ntools: ["Read"]\nmodel: opus\n---\nThe `a` agent.\n')
    const red = await checkSkills([], process.env, root)
    assert.equal(red.exitCode, 1)
    assert.ok(red.stderr.some(l => l.includes('skills/s/SKILL.md') && l.includes('craft:review')), red.stderr.join('\n'))
    assert.ok(red.stderr.some(l => l.includes('agents/a') && l.includes('craft:a')), red.stderr.join('\n'))
    put('skills/s/SKILL.md', '---\nname: s\ndescription: d\n---\nRun the `craft:review` workflow.\n')
    put('agents/a.md', '---\nname: a\ndescription: d\ntools: ["Read"]\nmodel: opus\n---\nThe `craft:a` agent.\n')
    const green = await checkSkills([], process.env, root)
    assert.equal(green.exitCode, 0, green.stderr.join('\n'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// The gate's inventory: no launch site found anywhere is a check that saw nothing, not a pass.
test('an inventory with no launch site fails closed, and an aliased-only launch is refused', () => {
  const t = /** @type {NonNullable<typeof ts>} */ (ts)
  const none = launchProblems(t, [{ f: 'w.js', src: wrap('return 1') }], KNOWN)
  assert.equal(none.seen, 0)
  assert.equal(none.problems.length, 1)
  assert.match(none.problems[0] ?? '', /no launch site/)
  const aliased = launchProblems(t, [{ f: 'w.js', src: wrap("const wf = workflow\nreturn await wf('review', {})") }], KNOWN)
  assert.deepEqual(aliased.problems.map(p => p.replace(/ ::.*/, '')), ['w.js:2'])
  const sound = launchProblems(t, [{ f: 'w.js', src: wrap("return await workflow('craft:review', {})") }], KNOWN)
  assert.deepEqual(sound, { seen: 1, problems: [] })
  assert.deepEqual(launchProblems(t, engines, KNOWN).problems, [], 'the shipped engines pass')
})
