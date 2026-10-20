// The workflow gate over a whole small checkout with tsc installed: a clean tree passes with every check's ok
// line, and each check's failure alone fails it — also beside a second failure, so no count cancels another.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './check-workflows.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSCONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'tsconfig.json'), 'utf8'))
const region = (/** @type {string} */ names, /** @type {string} */ body) => `// >>> craft-inline lib/one.mjs ${names}\n${body}\n// <<< craft-inline\n`

// The phrase in the string comes first: only the line-leading `export` is the sandbox's to strip.
const A_JS = "const note = 'see export const meta'\nexport const meta = { name: 'a' }\nconst CRAFT_VERSION = '1.0.0'\nlogRun(note, CRAFT_VERSION)\nreturn workflow('craft:a')\n"
/** @type {Record<string, string>} */
const CLEAN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'craft', version: '1.0.0' }),
  'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['**/*.mjs'] }),
  'lib/workflow-sandbox.d.ts': fs.readFileSync(path.join(ROOT, 'lib', 'workflow-sandbox.d.ts'), 'utf8'),
  'lib/one.mjs': '// a comment the region drops\nexport function one() { return 1 }\n',
  'src/w.js': `export const meta = { name: 'w' }\n${region('one', 'function one() { return 1 }')}`,
  'workflows/b.js': "export const meta = { name: 'b' }\nreturn workflow('craft:b')\n",
  'workflows/README.md': 'not an engine\n',
  'workflows/a.js': A_JS,
}

const OK = {
  version: 'ok    a.js CRAFT_VERSION 1.0.0 matches the manifest',
  region: 'ok    1 inlined region(s) match their source',
  sandbox: 'ok    every name in inlined code resolves in the sandbox',
  launch: "ok    2 launch site(s) name the harness's prefixed id",
  resolved: 'ok    every inlined region resolves the helpers it calls',
  scope: 'ok    every inlined source is read by the strict type check, nothing switched off',
}
const TSC_MISSING = 'FAIL  tsc is not installed at opencode/plugin/node_modules/typescript/bin/tsc — run npm ci --prefix opencode/plugin'

/** @param {Record<string, string | null>} changes  null drops a file @param {{ tsc?: boolean }} [opts] */
async function gate(changes, { tsc = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cwg-'))
  try {
    for (const [rel, body] of Object.entries({ ...CLEAN, ...changes })) {
      if (body === null) continue
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
    if (tsc) {
      fs.mkdirSync(path.join(root, 'opencode', 'plugin'), { recursive: true })
      fs.symlinkSync(path.join(ROOT, 'opencode', 'plugin', 'node_modules'), path.join(root, 'opencode', 'plugin', 'node_modules'))
    }
    return await run([], {}, root)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('a clean checkout passes, every check printing its ok line in order', async () => {
  const r = await gate({})
  assert.deepEqual(r.stderr, [])
  assert.deepEqual(r.stdout, ['ok    a.js', 'ok    b.js', '\n2/2 workflow scripts parse', OK.version, OK.region, OK.sandbox, OK.launch, OK.resolved, OK.scope])
  assert.equal(r.exitCode, 0)
})

test('an empty workflows/ fails even when its missing launch site is the only other finding', async () => {
  const r = await gate({ 'workflows/a.js': null, 'workflows/b.js': null })
  assert.equal(r.exitCode, 1)
  assert.equal(r.stdout[0], '\n0/0 workflow scripts parse')
  assert.equal(r.stderr[0], 'FAIL  workflows/ :: no .js scripts found — nothing was checked (this is a misconfiguration, not a pass)')
})

const BROKEN = { 'workflows/c.js': 'function (\n' }
/** @type {Array<[string, Record<string, string | null>, string[], string]>} what, changes, stderr, the ok line it loses */
const ALONE = [
  ['a stamp off the manifest', { 'workflows/a.js': A_JS.replace("'1.0.0'", "'0.9.0'") },
    ["FAIL  a.js :: CRAFT_VERSION '0.9.0' != plugin.json version '1.0.0'"], OK.version],
  ['a drifted region', { 'src/w.js': `export const meta = { name: 'w' }\n${region('one', 'function one() { return 2 }')}` },
    ['FAIL  w.js:2 :: inlined region [one] drifted from lib/one.mjs', '    - function one() { return 2 }\n    + function one() { return 1 }'], OK.region],
  ['a name the sandbox lacks', {
    'lib/one.mjs': 'export function one() { return nowhere }\n',
    'src/w.js': `export const meta = { name: 'w' }\n${region('one', 'function one() { return nowhere }')}`,
  }, ["FAIL  src/w.js:3 :: inlined code from lib/one.mjs uses a name the Workflow sandbox does not provide — Cannot find name 'nowhere'."], OK.sandbox],
  ['an unprefixed launch', { 'workflows/b.js': "export const meta = { name: 'b' }\nreturn workflow('b')\n" }, ["FAIL  b.js:2 :: workflow('b') launches without the `craft:` prefix — the installed plugin registers engines only as craft:<name>"], OK.launch],
]

for (const [what, changes, stderr, lost] of ALONE) {
  test(`${what} fails the gate, alone and beside a script that does not parse`, async () => {
    const alone = await gate(changes)
    assert.deepEqual(alone.stderr, stderr)
    assert.ok(!alone.stdout.includes(lost), alone.stdout.join('\n'))
    assert.equal(alone.exitCode, 1)
    const both = await gate({ ...changes, ...BROKEN })
    assert.equal(both.exitCode, 1)
    assert.ok(both.stdout.includes('\n2/3 workflow scripts parse'), both.stdout.join('\n'))
    assert.match(both.stderr[0] ?? '', /^FAIL {2}c\.js :: /)
  })
}

// The two checks outside the failure count each fail the gate on their own.
test('a region calling a sibling its fence does not carry fails the gate by itself', async () => {
  const r = await gate({
    'lib/one.mjs': "export function one() { return log('x') }\nexport function log(/** @type {string} */ m) { return m }\n",
    'src/w.js': `export const meta = { name: 'w' }\n${region('one', "function one() { return log('x') }")}`,
  })
  assert.deepEqual(r.stderr, ['FAIL  w.js:2 :: inlined region from lib/one.mjs calls log(), a sibling export of lib/one.mjs that the fence header does not carry — add it'])
  assert.ok(!r.stdout.includes(OK.resolved))
  assert.equal(r.exitCode, 1)
})

test('an inlined source outside the strict type check fails the gate by itself', async () => {
  const r = await gate({ 'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['other.mjs'] }), 'lib/other.mjs': 'export {}\n' })
  assert.deepEqual(r.stderr, ['FAIL  lib/one.mjs is inlined into workflows/ but not read by the strict type check (tsc -p lib/tsconfig.json)'])
  assert.ok(!r.stdout.includes(OK.scope))
  assert.equal(r.exitCode, 1)
})

test('a drifted region and a refused one are two failures, neither cancelling the other', async () => {
  const r = await gate({
    'lib/one.mjs': 'export function one() { return 1 }\nexport function two() { return 2 }\n',
    'lib/three.mjs': 'export const three = `a\n// kept in the string\nb`\n',
    'src/w.js': `export const meta = { name: 'w' }\n${region('one two', 'function one() { return 1 }')}// >>> craft-inline lib/three.mjs three\n// <<< craft-inline\n`,
  })
  assert.deepEqual(r.stderr, [
    'FAIL  w.js:2 :: inlined region [one, two] drifted from lib/one.mjs',
    '    + \n    + function two() { return 2 }',
    'FAIL  w.js:5 :: inlined region from lib/three.mjs refused — Unexpected end of input',
  ])
  assert.ok(!r.stdout.some(l => l.includes('match their source')))
  assert.equal(r.exitCode, 1)
})

test('without tsc installed each tsc-backed check fails with the install hint', async () => {
  const r = await gate({}, { tsc: false })
  assert.deepEqual(r.stderr, [TSC_MISSING, TSC_MISSING, TSC_MISSING])
  assert.equal(r.exitCode, 1)
})

test('a tsc rejecting lib/tsconfig.json fails the scope check with the first five lines it said', async () => {
  const bogus = Object.fromEntries(['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map(k => [k, true]))
  const r = await gate({ 'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['**/*.mjs'], compilerOptions: { ...TSCONFIG.compilerOptions, ...bogus } }, null, 1) })
  const [head, ...lines] = (r.stderr.at(-1) ?? '').split(' | ')
  assert.match(head ?? '', /^FAIL {2}tsc -p lib\/tsconfig\.json failed: \S*lib\/tsconfig\.json\(\d+,\d+\): error TS5023: Unknown compiler option 'x1'\.$/)
  assert.deepEqual(lines.map(l => /'(x\d)'\.$/.exec(l)?.[1]), ['x2', 'x3', 'x4', 'x5'])
  assert.equal(r.exitCode, 1)
})

test('a one-line tsc failure is reported trimmed, with no empty tail', async () => {
  const r = await gate({ 'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['nothing/*.mjs'] }) })
  assert.match(r.stderr.at(-1) ?? '', /^FAIL {2}tsc -p lib\/tsconfig\.json failed: error TS18003: No inputs were found in config file '[^']*'\. Specified 'include' paths were '\["nothing\/\*\.mjs"\]' and 'exclude' paths were '\[\]'\.$/)
  assert.equal(r.exitCode, 1)
})

// --showConfig does not look for the listed files; --listFilesOnly does, and its failure alone is enough.
test('a listed file tsc cannot find fails the scope check', async () => {
  const r = await gate({ 'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['**/*.mjs'], files: ['gone.mjs'] }) })
  assert.match(r.stderr.at(-1) ?? '', /^FAIL {2}tsc -p lib\/tsconfig\.json failed: error TS6053: File '\S*lib\/gone\.mjs' not found\. \| {3}The file is in the program because:/)
  assert.equal(r.exitCode, 1)
})
