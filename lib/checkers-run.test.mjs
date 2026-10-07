// The skill, eval and delivery-parity gates as commands, run in-process (realm @nick/craft, #172): each
// passes a clean copy of this repository's inputs and fails the same copy with one defect planted.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run as checkSkills } from './check-skills.mjs'
import { run as checkEvals } from './check-evals.mjs'
import { run as checkParity } from './check-delivery-parity.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/** @param {string[]} dirs  copied from this checkout @returns {string} */
function copyOf(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-chk-'))
  for (const d of dirs) fs.cpSync(path.join(REPO, d), path.join(root, d), { recursive: true })
  return root
}

/** @param {string} root @param {(root: string) => Promise<void>} body */
async function inside(root, body) {
  try { await body(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('check-skills: a clean copy passes; a dangling craft: ref fails and names its skill', () => inside(copyOf(['skills', 'agents', 'src', 'workflows', '.claude-plugin']), async root => {
  const clean = await checkSkills([], process.env, root)
  assert.equal(clean.exitCode, 0, clean.stderr.join('\n'))
  fs.appendFileSync(path.join(root, 'skills', 'debugging', 'SKILL.md'), '\nSee craft:no-such-skill.\n')
  const r = await checkSkills([], process.env, root)
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stderr.filter(l => l.includes('no-such-skill')).map(l => l.includes('skills/debugging')), [true])
}))

test('check-skills: directories that yield nothing fail as a misconfiguration', () => inside(copyOf([]), async root => {
  for (const d of ['skills', 'agents', 'src', 'workflows']) fs.mkdirSync(path.join(root, d))
  const r = await checkSkills([], process.env, root)
  assert.equal(r.exitCode, 1)
  // three empty directories, and no manifest to name the plugin a launch must be prefixed with
  assert.equal(r.stderr.length, 4)
  assert.ok(r.stderr.some(l => l.includes('.claude-plugin/plugin.json')), r.stderr.join('\n'))
}))

/** @param {unknown} corpus @returns {string} */
function evalsRoot(corpus) {
  const root = copyOf([])
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), '')
  fs.mkdirSync(path.join(root, 'evals'))
  fs.writeFileSync(path.join(root, 'evals', 'evals.json'), typeof corpus === 'string' ? corpus : JSON.stringify(corpus))
  return root
}
const CASE = { skills: ['a'], query: 'q', expected_behavior: ['x'] }

test('check-evals: a well-formed corpus passes', () => inside(evalsRoot([CASE]), async root => {
  const r = await checkEvals([], process.env, root)
  assert.equal(r.exitCode, 0)
  assert.deepEqual(r.stderr, [])
}))

test('check-evals: an unknown skill and unreadable JSON each fail', async () => {
  await inside(evalsRoot([{ ...CASE, skills: ['nope'] }]), async root => {
    const r = await checkEvals([], process.env, root)
    assert.equal(r.exitCode, 1)
    assert.equal(r.stderr.length, 1)
  })
  await inside(evalsRoot('{'), async root => {
    const r = await checkEvals([], process.env, root)
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.stdout, [], 'nothing is counted when the corpus cannot be read')
  })
})

test('check-delivery-parity: paired agents pass; an agent shipped for one delivery only fails', () => inside(copyOf(['agents', 'opencode/agents']), async root => {
  const clean = await checkParity([], process.env, root)
  assert.equal(clean.exitCode, 0, clean.stderr.join('\n'))
  fs.rmSync(path.join(root, 'opencode', 'agents', 'rust-miri.md'))
  const r = await checkParity([], process.env, root)
  assert.equal(r.exitCode, 1)
  assert.ok(r.stderr.some(l => l.includes('rust-miri')))
}))

test('check-delivery-parity: no agents at all fails instead of passing vacuously', () => inside(copyOf(['opencode/agents']), async root => {
  fs.mkdirSync(path.join(root, 'agents'))
  const r = await checkParity([], process.env, root)
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout, [])
}))
