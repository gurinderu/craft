// The check of every built engine whole against the sandbox's names (lib/built-sandbox-names.mjs): each planted
// reach for the host is refused at its place in the shipped file, and the committed workflows/ is clean.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { builtNameProblems } from './built-sandbox-names.mjs'
import { ROOT } from './repo-root.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = /** @type {NonNullable<ReturnType<typeof loadTypescript>>} */ (loadTypescript(ROOT))
const needsTs = loadTypescript(ROOT) || process.env['CI'] ? {} : { skip: true }

/** @param {Record<string, string>} workflows @returns {string} a root borrowing lib/'s tsconfig and sandbox declaration */
function fakeRoot(workflows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-wfb-test-'))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.mkdirSync(path.join(root, 'workflows'))
  for (const f of ['tsconfig.json', 'workflow-sandbox.d.ts']) fs.symlinkSync(path.join(ROOT, 'lib', f), path.join(root, 'lib', f))
  fs.writeFileSync(path.join(root, 'lib', 'x.mjs'), 'export {}\n')   // lib/tsconfig.json must find an input
  for (const [f, text] of Object.entries(workflows)) fs.writeFileSync(path.join(root, 'workflows', f), text)
  return root
}

/** @param {Record<string, string>} workflows */
function problemsOf(workflows) {
  const root = fakeRoot(workflows)
  try { return builtNameProblems(root, ts).problems } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('a built engine using only the sandbox and the ES library passes', needsTs, () => {
  const clean = "export const meta = { name: 'a' }\nasync function __run(){log(JSON.stringify(args));setTimeout(()=>{},1);return await agent('x',{label:'l'})}\nreturn await __run();\n"
  assert.deepEqual(problemsOf({ 'a.js': clean }), [])
})

test('every free name and route to the host is refused at its line and column of the shipped file', needsTs, () => {
  const bad = "export const meta = { name: 'b' }\nasync function __run(){return [process.env, new TextEncoder(), require('x'), globalThis.y, eval('1'), console]}\nreturn await __run();\n"
  const p = problemsOf({ 'b.js': bad })
  const lines = p.join('\n')
  assert.match(lines, /workflows\/b\.js:2:32 :: uses a name the Workflow sandbox does not provide — Cannot find name 'process'/)
  assert.match(lines, /workflows\/b\.js:2:\d+ :: uses a name the Workflow sandbox does not provide — Cannot find name 'TextEncoder'/)
  assert.match(lines, /workflows\/b\.js:2:\d+ :: calls require/)
  assert.match(lines, /workflows\/b\.js:2:\d+ :: reaches for globalThis/)
  assert.match(lines, /workflows\/b\.js:2:\d+ :: uses eval/)
  assert.match(lines, /Cannot find name 'console'/)
})

test('an empty workflows/ is a failure, not a pass', needsTs, () => {
  assert.match(problemsOf({}).join('\n'), /no \.js engines found — the built-name check read nothing/)
})

test('the committed workflows/ uses no name the sandbox lacks, and a bundled engine\'s place is given in its source', needsTs, () => {
  const { problems, files } = builtNameProblems(ROOT, ts)
  assert.deepEqual(problems, [])
  assert.ok(files >= 6)
  const pin = fs.readFileSync(path.join(ROOT, 'workflows', 'rust-review.js'), 'utf8').replace('languages:["rust"]', 'languages:[process]')
  const map = fs.readFileSync(path.join(ROOT, 'workflows', 'rust-review.js.map'), 'utf8')
  assert.match(problemsOf({ 'rust-review.js': pin, 'rust-review.js.map': map }).join('\n'), /^workflows\/rust-review\.js:7:\d+ \(src\/rust-review\.js:\d+:\d+\) :: uses a name .* 'process'/)
})
