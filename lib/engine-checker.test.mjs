// compileProject is `tsc -p <config> --pretty false` in process: the same diagnostics, the same text, the
// same exit status. Each case compiles a scratch project with the pinned compiler.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileProject } from './engine-checker.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the compiler these skip locally; in CI they run and fail, so a missing install is never a green
// run (Vitest's skip option carries no reason to report). Needs npm ci --prefix opencode/plugin.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const T = /** @type {NonNullable<typeof ts>} */ (ts)

/** @param {Record<string, string>} files @param {(dir: string) => void} check */
function withProject(files, check) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-compile-')))
  try {
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body)
    check(dir)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

const CONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] })

test('a clean project: status 0, no text, and the program it compiled', needsTs, () => {
  withProject({ 'tsconfig.json': CONFIG, 'a.ts': 'export const x: number = 1\n' }, dir => {
    const run = compileProject(T, path.join(dir, 'tsconfig.json'))
    assert.equal(run.status, 0)
    assert.equal(run.text, '')
    assert.ok(run.program?.getSourceFile(path.join(dir, 'a.ts')))
  })
})

test('errors: status 1, one line each, at a path relative to the working directory, as tsc prints them', needsTs, () => {
  withProject({ 'tsconfig.json': CONFIG, 'a.ts': 'export const x: number = "s"\nexport const y: string = 2\n' }, dir => {
    const run = compileProject(T, path.join(dir, 'tsconfig.json'))
    assert.equal(run.status, 1)
    const rel = path.relative(process.cwd(), path.join(dir, 'a.ts')).split(path.sep).join('/')
    assert.deepEqual(run.text.trimEnd().split('\n'), [
      `${rel}(1,14): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `${rel}(2,14): error TS2322: Type 'number' is not assignable to type 'string'.`,
    ])
  })
})

test('a diagnostic that is not an error leaves the status 0', needsTs, () => {
  // tsc's pre-emit diagnostics are all errors in practice; a warning is planted to pin the category test.
  withProject({ 'tsconfig.json': CONFIG, 'a.ts': 'export {}\n' }, dir => {
    const warning = /** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').Diagnostic} */ ({
      category: T.DiagnosticCategory.Warning, code: 1, file: undefined, start: undefined, length: undefined, messageText: 'just a warning',
    })
    const run = compileProject({ ...T, getPreEmitDiagnostics: () => [warning] }, path.join(dir, 'tsconfig.json'))
    assert.equal(run.status, 0)
    assert.match(run.text, /warning TS1: just a warning/)
  })
})

test('a config that cannot be read: no program, status 1, and the reason in the text', needsTs, () => {
  withProject({}, dir => {
    const run = compileProject(T, path.join(dir, 'absent.json'))
    assert.equal(run.program, null)
    assert.equal(run.status, 1)
    assert.match(run.text, /error TS5083: Cannot read file .*absent\.json/)
  })
})
