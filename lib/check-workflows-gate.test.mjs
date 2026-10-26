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

// The phrase in the string comes first: only the line-leading `export` is the sandbox's to strip.
const A_JS = "const note = 'see export const meta'\nexport const meta = { name: 'a' }\nconst CRAFT_VERSION = '1.0.0'\nfunction logRun(...a) { return a }\nlogRun(note, CRAFT_VERSION)\nreturn workflow('craft:a')\n"
/** @type {Record<string, string>} */
const CLEAN = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'craft', version: '1.0.0' }),
  'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['**/*.mjs'] }),
  'lib/workflow-sandbox.d.ts': fs.readFileSync(path.join(ROOT, 'lib', 'workflow-sandbox.d.ts'), 'utf8'),
  'lib/one.mjs': 'export function one() { return 1 }\n',
  'src/w.js': "import { one } from '../lib/one.mjs'\n\nexport const meta = { name: 'w' }\n\nexport async function __run() {\nreturn one()\n}\n",
  'workflows/b.js': "export const meta = { name: 'b' }\nreturn workflow('craft:b')\n",
  'workflows/README.md': 'not an engine\n',
  'workflows/a.js': A_JS,
}

const OK = {
  version: 'ok    a.js CRAFT_VERSION 1.0.0 matches the manifest',
  built: 'ok    every name in the 2 built engine(s) resolves in the sandbox',
  launch: "ok    2 launch site(s) name the harness's prefixed id",
  scope: 'ok    every bundled lib/ module is read by the strict type check, nothing switched off',
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
  assert.deepEqual(r.stdout, ['ok    a.js', 'ok    b.js', '\n2/2 workflow scripts parse', OK.version, OK.built, OK.launch, OK.scope])
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
  ['a name the sandbox lacks in a built engine', { 'workflows/b.js': "export const meta = { name: 'b' }\nreturn workflow('craft:b', nowhere)\n" },
    ["FAIL  workflows/b.js:2:28 :: uses a name the Workflow sandbox does not provide — Cannot find name 'nowhere'."], OK.built],
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

// The scope check sits outside the failure count and fails the gate on its own.
test('a bundled lib/ module outside the strict type check fails the gate by itself', async () => {
  const r = await gate({ 'lib/tsconfig.json': JSON.stringify({ ...TSCONFIG, include: ['other.mjs'] }), 'lib/other.mjs': 'export {}\n' })
  assert.deepEqual(r.stderr, ['FAIL  lib/one.mjs is bundled into workflows/ but not read by the strict type check (tsc -p lib/tsconfig.json)'])
  assert.ok(!r.stdout.includes(OK.scope))
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
