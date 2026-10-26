// What a bundle may not carry (lib/engine-bundle-checks.mjs): each module route, and each name no source spells.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { bundleProblems } from './engine-bundle-checks.mjs'
import { ROOT } from './repo-root.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = /** @type {NonNullable<ReturnType<typeof loadTypescript>>} */ (loadTypescript(ROOT))
const needsTs = loadTypescript(ROOT) || process.env['CI'] ? {} : { skip: true }
const BANNER = "export const meta = { name: 'x' }"
const SOURCES = [{ file: 'src/x.js', text: `${BANNER}\nexport async function __run() { return f(args) }\nfunction f(a) { return a }` }]

/** @param {string} code */
const problems = code => bundleProblems(ts, `${BANNER}\n${code}`, BANNER, SOURCES)

test('a bundle that spells only its sources\' names and reaches no module is clean', needsTs, () => {
  assert.deepEqual(problems('function f(a){return a}async function __run(){return f(args)}'), [])
})

test('every module route left in a bundle is refused', needsTs, () => {
  assert.deepEqual(problems("import f from './f.js';async function __run(){return f(args)}"), ["an import survives (`import f from './f.js';`)"])
  assert.deepEqual(problems('async function __run(){return f(args)}export{__run}'), ['an export survives (`export{__run}`)'])
  assert.deepEqual(problems('export async function __run(){return f(args)}'), ['an export survives (`export async function __run(){return f(args)}`)'])
  assert.match(problems('async function __run(){return import(args)}').join('\n'), /a dynamic import\(\) survives/)
  assert.match(problems('async function __run(){return import.meta}').join('\n'), /import\.meta survives/)
  assert.match(problems('async function __run(){return require(args)}').join('\n'), /require survives/)
  const withProperty = [{ file: 'src/x.js', text: 'args.require' }]
  assert.deepEqual(bundleProblems(ts, `${BANNER}\nasync function __run(){return args.require}`, BANNER, [...SOURCES, ...withProperty]), [], 'a property named require is no route')
})

test('a name no source spells is refused by name, and a bundle that lost its banner is refused', needsTs, () => {
  assert.deepEqual(problems('function f2(a){return a}async function __run(){return f2(args)}'),
    ['the bundle spells `f2`, a name none of its sources spells — esbuild renamed a binding that shadows another or a used global (rename it in the source), or added a helper of its own'])
  assert.deepEqual(bundleProblems(ts, 'async function __run(){return f(args)}', BANNER, SOURCES), ['the bundle does not open with its banner'])
})

test('a property the syntax minifier unquoted is no rename: `o[\'name\']` and `{ \'name\': v }` ship as `o.name` and `{name:v}`', needsTs, () => {
  const quoted = [{ file: 'src/x.js', text: "args['quotedKey'];({ 'quotedField': 1 })" }]
  assert.deepEqual(bundleProblems(ts, `${BANNER}\nasync function __run(){return [args.quotedKey,{quotedField:1}]}`, BANNER, [...SOURCES, ...quoted]), [])
  assert.match(bundleProblems(ts, `${BANNER}\nasync function __run(){const quotedKey=1;return quotedKey}`, BANNER, [...SOURCES, ...quoted]).join('\n'), /spells `quotedKey`/, 'the same name as a binding still is')
})
