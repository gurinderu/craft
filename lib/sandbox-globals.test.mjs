import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absentGlobalUses, codeOnly } from './sandbox-globals.mjs'

test('absentGlobalUses finds each absent global used as code, at its line', () => {
  const src = [
    'const e = new TextEncoder()',
    'const p = process.env.X',
    'const m = require("node:fs")',
    'const d = new TextDecoder("utf-8")',
  ].join('\n')
  assert.deepEqual(absentGlobalUses(src), [
    { line: 1, name: 'TextEncoder' }, { line: 2, name: 'process' }, { line: 3, name: 'require' }, { line: 4, name: 'TextDecoder' },
  ])
})

test('absentGlobalUses ignores comments, strings, template text and property names — but not `${…}` code', () => {
  const src = [
    '// new TextEncoder() in a comment',
    '/* process.env',
    '   require() */',
    "const a = 'process the require list'",
    'const b = "TextDecoder is absent"',
    'const c = `to process ${x.length} files`',
    'const d = job.process + run.require',
    'const processed = 1, requireAll = 2',
    'const e = `x ${process.env.Y} y`',
  ].join('\n')
  assert.deepEqual(absentGlobalUses(src), [{ line: 9, name: 'process' }])
})

test('codeOnly keeps line numbering through blanked comments and strings', () => {
  const src = 'a /* x\ny */ b\n`t\nu` c'
  assert.equal(codeOnly(src).split('\n').length, src.split('\n').length)
  assert.match(codeOnly(src), /b/)
  assert.match(codeOnly(src), /c/)
})
