// What the floor is measured over, and whether the run applies it: the two ways a change could lower the
// real floor while integrations/shared/mutation-floor.json's number stays put — a narrower `mutate`, or `thresholds` that
// no longer come from the file (integrations/shared/check-mutation-floor.mjs).
import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkMutationFloor } from './check-mutation-floor.mjs'

const MUTATE = ['integrations/shared/**/*.mjs', '!integrations/shared/**/*.test.mjs', '!integrations/shared/engine-harness.mjs']

// A config that takes both from the floor file, as integrations/shared/config/stryker.config.mjs does.
const DERIVED = `import fs from 'node:fs'
const f = JSON.parse(fs.readFileSync(new URL('../mutation-floor.json', import.meta.url), 'utf8'))
export default { mutate: f.mutate, thresholds: { high: Math.max(80, f.break), low: f.break, break: f.break } }
`

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** @typedef {{ mutate?: string[], config?: string }} Side */

/** @param {string} root @param {Side} side */
function write(root, { mutate = MUTATE, config = DERIVED }) {
  fs.writeFileSync(path.join(root, 'integrations/shared', 'mutation-floor.json'), JSON.stringify({ break: 70, mutate }))
  fs.mkdirSync(path.join(root, 'integrations/shared/config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'integrations/shared/config/stryker.config.mjs'), config)
}

/**
 * A repo whose first commit holds `base`, its working tree `head`; the floor itself is 70 on both.
 * @param {Side} base @param {Side} head @returns {{ root: string, base: string }}
 */
function repo(base, head) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-scope-'))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'integrations/shared'), { recursive: true })
  git(root, ['init', '-q'])
  write(root, base)
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  write(root, head)
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

/** @param {Side} base @param {Side} head @returns {Promise<string[]>} */
async function check(base, head) {
  const r = repo(base, head)
  return checkMutationFloor(r.root, r.base)
}

test('an unchanged scope passes', async () => {
  assert.deepEqual(await check({}, {}), [])
})

test('a glob dropped from `mutate` fails', async () => {
  assert.notDeepEqual(await check({}, { mutate: MUTATE.filter(g => g !== 'integrations/shared/**/*.mjs').concat('integrations/shared/x.mjs') }), [])
})

test('a `!` exclusion added to `mutate` fails', async () => {
  assert.notDeepEqual(await check({}, { mutate: [...MUTATE, '!integrations/shared/review-*.mjs'] }), [])
})

// Stryker applies `mutate` in order — an exclusion unmarks what came before it, an include after it marks
// again — so the same globs in another order can measure fewer files.
test('an include after an exclusion fails, with a base and without one', async () => {
  const reincluded = ['integrations/shared/**/*.mjs', '!integrations/shared/**/*.test.mjs', 'integrations/shared/x.test.mjs']
  assert.notDeepEqual(await check({}, { mutate: reincluded }), [])
  const { root } = repo({}, { mutate: reincluded })
  assert.notDeepEqual(await checkMutationFloor(root, null), [])
})

test('narrowing by reordering the same globs fails', async () => {
  const base = ['integrations/shared/**/*.mjs', '!integrations/shared/**/*.test.mjs', 'integrations/shared/x.test.mjs']
  assert.notDeepEqual(
    await check({ mutate: base }, { mutate: ['integrations/shared/**/*.mjs', 'integrations/shared/x.test.mjs', '!integrations/shared/**/*.test.mjs'] }),
    [],
  )
})

test('widening `mutate` passes — a glob added, an exclusion removed', async () => {
  assert.deepEqual(await check({}, { mutate: ['integrations/claude-code/workflows/*.js', ...MUTATE] }), [])
  assert.deepEqual(await check({}, { mutate: MUTATE.filter(g => g !== '!integrations/shared/engine-harness.mjs') }), [])
})

test('a config whose `break` is a literal instead of the floor fails', async () => {
  const literal = `export default { mutate: ${JSON.stringify(MUTATE)}, thresholds: { high: 80, low: 70, break: 0 } }\n`
  assert.notDeepEqual(await check({}, { config: literal }), [])
})

test('a config without `thresholds.break` fails', async () => {
  const none = `export default { mutate: ${JSON.stringify(MUTATE)} }\n`
  assert.notDeepEqual(await check({}, { config: none }), [])
})

test("a config whose `mutate` is not the floor file's fails", async () => {
  const narrow = DERIVED.replace('mutate: f.mutate', "mutate: ['integrations/shared/x.mjs']")
  assert.notDeepEqual(await check({}, { config: narrow }), [])
})

test('without a base, a config that does not apply the floor still fails', async () => {
  const { root } = repo({}, { config: `export default { mutate: ${JSON.stringify(MUTATE)}, thresholds: { break: 0 } }\n` })
  assert.notDeepEqual(await checkMutationFloor(root, null), [])
})
