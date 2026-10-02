import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkMutationFloor, floorProblems, parseFloor } from './check-mutation-floor.mjs'

test('floorProblems: a floor lowered against the base fails, naming both values', () => {
  const problems = floorProblems(65, 70)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /from 70 to 65/)
})

test('floorProblems: an equal or a raised floor passes', () => {
  assert.deepEqual(floorProblems(70, 70), [])
  assert.deepEqual(floorProblems(72.5, 70), [])
})

test('floorProblems: no floor on the base (the file is new) passes', () => {
  assert.deepEqual(floorProblems(70, null), [])
})

test('parseFloor: reads `break` as a percentage and refuses anything else', () => {
  assert.equal(parseFloor('{ "break": 70 }'), 70)
  for (const bad of ['{}', '{ "break": "70" }', '{ "break": -1 }', '{ "break": 101 }', '[70]', 'not json']) {
    assert.throws(() => parseFloor(bad), /mutation-floor\.json/, bad)
  }
})

test('the committed floor is readable', () => {
  const text = fs.readFileSync(new URL('./mutation-floor.json', import.meta.url), 'utf8')
  assert.ok(parseFloor(text) > 0)
})

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A repo whose first commit holds `baseFloor` (or no floor file when null), its working tree `headFloor`.
 * @param {number | null} baseFloor @param {number} headFloor @returns {{ root: string, base: string }}
 */
function repo(baseFloor, headFloor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-floor-'))
  fs.mkdirSync(path.join(root, 'lib'))
  git(root, ['init', '-q'])
  fs.writeFileSync(path.join(root, 'README'), 'x\n')
  if (baseFloor !== null) fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), JSON.stringify({ break: baseFloor }))
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), JSON.stringify({ break: headFloor }))
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

test('checkMutationFloor: against a base in git — lower fails, equal and higher pass', () => {
  for (const [head, failures] of /** @type {const} */ ([[65, 1], [70, 0], [75, 0]])) {
    const { root, base } = repo(70, head)
    assert.equal(checkMutationFloor(root, base).length, failures, `head ${head}`)
  }
})

test('checkMutationFloor: a base without the file passes', () => {
  const { root, base } = repo(null, 70)
  assert.deepEqual(checkMutationFloor(root, base), [])
})

test('checkMutationFloor: a base that is no commit here fails loudly instead of passing', () => {
  const { root } = repo(70, 70)
  const problems = checkMutationFloor(root, 'no-such-ref')
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /no-such-ref/)
})

test('checkMutationFloor: without a base only the file itself is checked', () => {
  const { root } = repo(70, 70)
  assert.deepEqual(checkMutationFloor(root, null), [])
  fs.writeFileSync(path.join(root, 'lib', 'mutation-floor.json'), '{}')
  assert.equal(checkMutationFloor(root, null).length, 1)
})
