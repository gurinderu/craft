import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { directiveProblems, directiveSites } from './ts-directives.mjs'
import { ROOT } from './inline-regions.mjs'
import { loadTypescript } from './run-tsc.mjs'

const ts = loadTypescript(ROOT)
// Without the pinned compiler these skip locally; CI installs it, so there they run.
const needsTs = ts || process.env['CI'] ? {} : { skip: true }
const TS = /** @type {NonNullable<typeof ts>} */ (ts)
const parse = (/** @type {string} */ src) => TS.createSourceFile('x.js', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.JS)

/** How many errors the real checker reports for `src` as a checked JS file. */
function errorsUnder(/** @type {string} */ src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-tsd-'))
  try {
    const file = path.join(dir, 'x.mjs')
    fs.writeFileSync(file, src)
    const program = TS.createProgram([file], { allowJs: true, checkJs: true, strict: true, noEmit: true, noUncheckedIndexedAccess: true, types: [] })
    return TS.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === file).length
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// Each shape: the line before a planted error. A directive is refused exactly where tsc honours it.
const SHAPES = [
  ['// @ts-ignore', true], ['const n = 1 // @ts-ignore', true], ['const n = 1 /* @ts-ignore */', true],
  ['const n = 1 // @ts-expect-error', true], ['const n = 1 /** @ts-expect-error */', true],
  ['const n = 1 /// @ts-ignore', true], ['/* why\n   @ts-ignore */', true],
  ['/* @ts-ignore\n   not on the last line */', false], ['// never write @ts-ignore', false],
  ["const s = '// @ts-ignore'", false], ['const s = `\n// @ts-ignore\n`', false],
  ['/** @param {string} s @ts-ignore here */', false],
]

test('a directive is refused exactly where the real checker lets it hide an error', needsTs, () => {
  for (const [shape, honoured] of SHAPES) {
    const src = `${shape}\nexport const bad = [1][0].toFixed()\n`
    assert.equal(errorsUnder(src) === 0, honoured, `tsc on: ${shape}`)
    assert.equal(/** @type {unknown[]} */ (directiveSites(parse(src))).length > 0, honoured, `refusal of: ${shape}`)
  }
})

test('@ts-nocheck counts only as tsc reads it: a leading `//` pragma, and a later @ts-check turns it back on', needsTs, () => {
  for (const [head, honoured] of [['// @ts-nocheck', true], ['// a note\n// @ts-nocheck', true], ['/* @ts-nocheck */', false],
    ['const z = 1\n// @ts-nocheck', false], ['// @ts-nocheck\n// @ts-check', false]]) {
    const src = `${head}\nexport const bad = [1][0].toFixed()\n`
    assert.equal(errorsUnder(src) === 0, honoured, `tsc on: ${head}`)
    assert.deepEqual(directiveSites(parse(src))?.map(s => s.directive), honoured ? ['@ts-nocheck'] : [], head)
  }
})

test('each directive is reported once, at its own line, in source order, against the file named', needsTs, () => {
  const src = '// @ts-nocheck\nconst a = 1\nconst b = 2 // @ts-expect-error\nconst c = 3\n/*\n  @ts-ignore */\nexport { a, b, c }\n'
  const sf = parse(src)
  assert.deepEqual(directiveSites(sf), [
    { line: 1, directive: '@ts-nocheck' }, { line: 3, directive: '@ts-expect-error' }, { line: 6, directive: '@ts-ignore' },
  ])
  const problems = directiveProblems(sf, 'workflows/x.js')
  assert.deepEqual(problems.map(p => /^workflows\/x\.js:(\d+) .*(@ts-[a-z-]+)$/.exec(p)?.slice(1)), [['1', '@ts-nocheck'], ['3', '@ts-expect-error'], ['6', '@ts-ignore']])
  assert.deepEqual(directiveProblems(parse('export const a = 1\n'), 'workflows/x.js'), [])
})

test('a TypeScript that keeps no directive record fails the check, it never reads as directive-free', () => {
  const sf = /** @type {import('../opencode/plugin/node_modules/typescript/lib/typescript.js').SourceFile} */ (/** @type {unknown} */ ({ text: '', checkJsDirective: undefined }))
  assert.equal(directiveSites(sf), null)
  assert.equal(directiveProblems(sf, 'workflows/x.js').length, 1)
  const noPragma = /** @type {typeof sf} */ (/** @type {unknown} */ ({ text: '', commentDirectives: undefined }))
  assert.equal(directiveSites(noPragma), null)
})
