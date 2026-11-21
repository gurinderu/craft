import { onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkMutationFloor, configProblems, floorProblems } from './check-mutation-floor.mjs'
import { parseFloor } from './mutation-floor.mjs'

const MUTATE = ['integrations/shared/**/*.mjs', '!integrations/shared/**/*.test.mjs']
/** @param {number} b @returns {{ break: number, mutate: string[] }} */
const at = b => ({ break: b, mutate: MUTATE })

test('floorProblems: a floor lowered against the base fails, naming both values', () => {
  const problems = floorProblems(at(65), at(70))
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /from 70 to 65/)
})

test('floorProblems: an equal or a raised floor passes', () => {
  assert.deepEqual(floorProblems(at(70), at(70)), [])
  assert.deepEqual(floorProblems(at(72.5), at(70)), [])
})

test('floorProblems: a narrowed `mutate` names the glob dropped and the exclusion added', () => {
  const problems = floorProblems(
    { break: 70, mutate: ['integrations/shared/x.mjs', '!integrations/shared/**/*.test.mjs', '!integrations/shared/y.mjs'] },
    at(70),
  )
  assert.deepEqual(
    problems.map(p => p.replace(/ — .*/, '')),
    [
      'integrations/shared/mutation-floor.json drops integrations/shared/**/*.mjs from `mutate`',
      'integrations/shared/mutation-floor.json adds the exclusion !integrations/shared/y.mjs to `mutate`',
    ],
  )
})

test('floorProblems: no floor on the base (the file is new) passes', () => {
  assert.deepEqual(floorProblems(at(70), null), [])
})

for (const directory of ['config', 'fixtures']) {
  test(`floorProblems: ${directory} coverage cannot be removed after widening in the new layout`, () => {
    const wide = at(70)
    const exclusion = `!integrations/shared/${directory}/**`
    const narrow = { ...wide, mutate: [...wide.mutate, exclusion] }
    assert.deepEqual(floorProblems(wide, narrow), [])
    assert.deepEqual(floorProblems(narrow, narrow), [])
    assert.deepEqual(floorProblems(narrow, wide), [
      `integrations/shared/mutation-floor.json adds the exclusion ${exclusion} to \`mutate\` — what the floor is measured over may only widen`,
    ])
  })
}

test('parseFloor: reads `break` as a percentage and `mutate` as globs, and refuses anything else', () => {
  // Both ends of the range are percentages, and so is a fraction: Stryker's `thresholds.break` takes any.
  for (const b of [0, 70, 72.5, 100]) assert.deepEqual(parseFloor(JSON.stringify(at(b))), at(b), String(b))
  const bad = [
    '{}',
    '{ "break": 70 }',
    '{ "break": "70", "mutate": ["a"] }',
    '{ "break": -1, "mutate": ["a"] }',
    '{ "break": 101, "mutate": ["a"] }',
    '{ "break": 100.5, "mutate": ["a"] }',
    '{ "break": 1e999, "mutate": ["a"] }',
    '{ "break": null, "mutate": ["a"] }',
    '{ "break": 70, "mutate": [] }',
    '{ "break": 70, "mutate": ["!a"] }',
    '{ "break": 70, "mutate": ["a", ""] }',
    '{ "break": 70, "mutate": ["a", { "length": 1 }] }',
    '{ "break": 70, "mutate": ["a", 1] }',
    '{ "break": 70, "mutate": ["a", "!b", "c"] }',
    '{ "break": 70, "mutate": ["!b", "a"] }',
    '{ "break": 70, "mutate": "a" }',
    '[70]',
    'not json',
  ]
  for (const text of bad) assert.throws(() => parseFloor(text), /mutation-floor\.json/, text)
})

test('configProblems: a config that takes both values from the file passes; anything else fails', () => {
  assert.deepEqual(configProblems({ mutate: [...MUTATE], thresholds: { break: 70 } }, at(70)), [])
  for (const config of [undefined, null, {}, { mutate: MUTATE }, { thresholds: { break: 70 } }, { mutate: MUTATE, thresholds: { break: 0 } }]) {
    assert.notDeepEqual(configProblems(config, at(70)), [], JSON.stringify(config))
  }
  assert.deepEqual(configProblems({ mutate: ['integrations/shared/x.mjs'], thresholds: { break: 0 } }, at(70)), [
    "integrations/shared/config/stryker.config.mjs's `mutate` is not integrations/shared/mutation-floor.json's `mutate`",
    "integrations/shared/config/stryker.config.mjs's `thresholds.break` is not integrations/shared/mutation-floor.json's `break`",
  ])
})

test('configProblems: a config that drops files before `mutate` applies fails; no or empty `ignorePatterns` passes', () => {
  // Stryker 10 filters the project through `ignorePatterns` (and the deprecated `files`, rewritten into
  // them) before `mutate` selects from what is left: either narrows the measured set with `mutate` unchanged.
  const applies = { mutate: [...MUTATE], thresholds: { break: 70 } }
  assert.deepEqual(configProblems({ ...applies, ignorePatterns: [] }, at(70)), [])
  for (const extra of [
    { ignorePatterns: ['integrations/shared/weak.mjs'] },
    { ignorePatterns: 'integrations/shared' },
    { files: ['integrations/shared/a.mjs'] },
  ]) {
    assert.equal(configProblems({ ...applies, ...extra }, at(70)).length, 1, JSON.stringify(extra))
  }
})

test('the committed floor is readable,and the committed Stryker config applies it', async () => {
  const text = fs.readFileSync(new URL('./mutation-floor.json', import.meta.url), 'utf8')
  assert.ok(parseFloor(text).break > 0)
  assert.deepEqual(await checkMutationFloor(), [])
})

/** @param {string} cwd @param {string[]} args @returns {string} */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** @param {string} root @param {number} floor */
const writeFloor = (root, floor) => fs.writeFileSync(path.join(root, 'integrations/shared', 'mutation-floor.json'), JSON.stringify(at(floor)))

/**
 * A repo whose first commit holds `baseFloor` (or no floor file when null), its working tree `headFloor`,
 * with a Stryker config that applies the file.
 * @param {number | null} baseFloor @param {number} headFloor @returns {{ root: string, base: string }}
 */
function repo(baseFloor, headFloor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-floor-'))
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'integrations/shared/config'), { recursive: true })
  git(root, ['init', '-q'])
  fs.writeFileSync(
    path.join(root, 'integrations/shared/config/stryker.config.mjs'),
    `import fs from 'node:fs'
const f = JSON.parse(fs.readFileSync(new URL('../mutation-floor.json', import.meta.url), 'utf8'))
export default { mutate: f.mutate, thresholds: { break: f.break } }
`,
  )
  if (baseFloor !== null) writeFloor(root, baseFloor)
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  writeFloor(root, headFloor)
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

test('checkMutationFloor: against a base in git — lower fails, equal and higher pass', async () => {
  for (const [head, failures] of /** @type {const} */ ([
    [65, 1],
    [70, 0],
    [75, 0],
  ])) {
    const { root, base } = repo(70, head)
    assert.equal((await checkMutationFloor(root, base)).length, failures, `head ${head}`)
  }
})

test('checkMutationFloor: a base without the file passes', async () => {
  const { root, base } = repo(null, 70)
  assert.deepEqual(await checkMutationFloor(root, base), [])
})

test('checkMutationFloor: a base that is no commit here fails loudly instead of passing', async () => {
  const { root } = repo(70, 70)
  const problems = await checkMutationFloor(root, 'no-such-ref')
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /no-such-ref/)
})

test('checkMutationFloor: without a base only the file and the config are checked', async () => {
  const { root } = repo(70, 70)
  assert.deepEqual(await checkMutationFloor(root, null), [])
  fs.writeFileSync(path.join(root, 'integrations/shared', 'mutation-floor.json'), '{}')
  assert.equal((await checkMutationFloor(root, null)).length, 1)
})

test('checkMutationFloor: a config that cannot be imported fails', async () => {
  const { root } = repo(70, 70)
  fs.rmSync(path.join(root, 'integrations/shared/config/stryker.config.mjs'))
  const problems = await checkMutationFloor(root, null)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /^integrations\/shared\/config\/stryker\.config\.mjs could not be imported: /)
})
