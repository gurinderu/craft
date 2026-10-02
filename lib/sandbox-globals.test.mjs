import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { absentGlobalUses } from './sandbox-globals.mjs'
import { findRegions, ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
const needsTs = ts ? {} : { skip: 'needs npm ci --prefix opencode/plugin' }
const uses = (/** @type {string} */ text) => absentGlobalUses(text, /** @type {NonNullable<typeof ts>} */ (ts))

test('absentGlobalUses finds each absent global used as code, at its line', needsTs, () => {
  const src = [
    'const e = new TextEncoder()',
    'const p = process.env.X',
    'const m = require("node:fs")',
    'const d = new TextDecoder("utf-8")',
  ].join('\n')
  assert.deepEqual(uses(src), [
    { line: 1, name: 'TextEncoder' }, { line: 2, name: 'process' }, { line: 3, name: 'require' }, { line: 4, name: 'TextDecoder' },
  ])
})

test('absentGlobalUses ignores comments, strings, template text and property names — but not `${…}` code', needsTs, () => {
  const src = [
    '// new TextEncoder() in a comment',
    '/* process.env',
    '   require() */',
    "const a = 'process the require list'",
    'const b = "TextDecoder is absent"',
    'const c = `to process ${x.length} files`',
    'const d = job.process + run.require + ({ process: 1 }).process',
    'const processed = 1, requireAll = 2',
    'const e = `x ${process.env.Y} y`',
  ].join('\n')
  assert.deepEqual(uses(src), [{ line: 9, name: 'process' }])
})

test('regex literals hide nothing: a backtick, a quote or a comment opener inside one', needsTs, () => {
  // Each of these blinded the hand-written stripper this replaced to the lines after it.
  const src = [
    'const r1 = /[#`*_]/g',
    "const r2 = /(\"([^\"]*)\"|'([^']*)')/g",
    'const r3 = /[/*]/',
    'const r4 = /a\\/\\//',
    'const enc = new TextEncoder()',
    'if (process.env.X) require("x")',
  ].join('\n')
  assert.deepEqual(uses(src), [{ line: 5, name: 'TextEncoder' }, { line: 6, name: 'process' }, { line: 6, name: 'require' }])
})

test('every current inlined region parses to its own line count, and none uses an absent global', needsTs, () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'workflows')).filter(n => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8')
    const lines = text.split('\n')
    for (const r of findRegions(text)) {
      const region = lines.slice(r.open, r.close + 1).join('\n')
      assert.deepEqual(uses(region), [], `${f}:${r.open + 1}`)
      // A use planted on the region's last code line is reported at exactly that line.
      const planted = [...lines.slice(r.open, r.close), 'void TextEncoder', /** @type {string} */ (lines[r.close])].join('\n')
      assert.deepEqual(uses(planted), [{ line: r.close - r.open + 1, name: 'TextEncoder' }], `${f}:${r.open + 1} plant`)
    }
  }
})
