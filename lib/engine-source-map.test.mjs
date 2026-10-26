// Reading a built engine's position back to its source (lib/engine-source-map.mjs): the VLQ decoding by hand,
// and the real bundled pins, whose positions must land on the very token in src/ or lib/.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SourceMap } from 'node:module'
import path from 'node:path'
import { decodeMappings, decodeVlq, locate, originalPosition, run } from './engine-source-map.mjs'
import { ROOT } from './inline-regions.mjs'

test('Base64 VLQ numbers decode with their sign and continuation bits', () => {
  assert.deepEqual(decodeVlq('AAAA'), [0, 0, 0, 0])
  assert.deepEqual(decodeVlq('CDEF'), [1, -1, 2, -2])
  assert.deepEqual(decodeVlq('gB'), [16])
  assert.deepEqual(decodeVlq('2HwmB'), [123, 616])
  assert.throws(() => decodeVlq('A!'), /not a Base64 VLQ digit/)
  assert.throws(() => decodeVlq('g'), /runs past the end/)
})

test('mappings decode to absolute positions per generated line; a column resolves to the segment at or before it', () => {
  // line 0: nothing; line 1: col 0 -> src 0 line 0 col 0, col 4 -> src 1 line 2 col 3; line 2: col 2 -> src 1 line 3 col 0
  const mappings = ';AAAA,ICEG;EACH'
  assert.deepEqual(decodeMappings(mappings), [[], [[0, 0, 0, 0], [4, 1, 2, 3]], [[2, 1, 3, 0]]])
  const map = { sources: ['a.js', 'b.js'], mappings }
  assert.deepEqual(originalPosition(map, 2, 1), { source: 'a.js', line: 1, column: 1 })
  assert.deepEqual(originalPosition(map, 2, 9), { source: 'b.js', line: 3, column: 4 })
  assert.equal(originalPosition(map, 1, 1), null)
  assert.equal(originalPosition(map, 3, 1), null, 'before the first segment of its line')
  assert.equal(originalPosition(map, 9, 1), null)
})

/** The 1-based line and column of the first `needle` in workflows/<engine>.js. @param {string} engine @param {string} needle */
function positionOf(engine, needle) {
  const lines = fs.readFileSync(path.join(ROOT, 'workflows', `${engine}.js`), 'utf8').split('\n')
  const line = lines.findIndex(l => l.includes(needle))
  return { line: line + 1, column: /** @type {string} */ (lines[line]).indexOf(needle) + 1 }
}

for (const [engine, lang] of /** @type {[string, string][]} */ ([['nix-review', 'nix'], ['rust-review', 'rust']])) {
  test(`${engine}: a position in the bundle reads back to the engine's own line, and to lib/ for inlined code`, () => {
    const call = positionOf(engine, 'nestedWorkflow(workflow,')
    const at = locate(ROOT, engine, call.line, call.column)
    assert.equal(at.file, `src/${engine}.js`)
    assert.match(/** @type {string} */ (at.text), new RegExp(`return await nestedWorkflow\\(workflow, 'review', .*languages: \\['${lang}'\\]`))
    const src = fs.readFileSync(path.join(ROOT, at.file), 'utf8').split('\n')[at.line - 1]
    assert.equal(src?.slice(at.column - 1).startsWith('nestedWorkflow('), true, 'the very token')
    const lib = positionOf(engine, 'unresolved(e2)')
    const inLib = locate(ROOT, `craft:${engine}`, lib.line, lib.column)
    assert.equal(inLib.file, 'lib/nested-workflow.mjs')
    assert.match(/** @type {string} */ (inLib.text), /if \(unresolved\(e2\)\)/)
  })
}

test('every segment of the shipped maps decodes as Node\'s own source-map reader decodes it', () => {
  for (const engine of ['nix-review', 'rust-review']) {
    const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', `${engine}.js.map`), 'utf8'))
    const node = new SourceMap(payload)
    const lines = decodeMappings(payload.mappings)
    assert.ok(lines.flat().length > 50, `${engine}: the map has segments`)
    lines.forEach((segs, line) => {
      for (const [col, src, l, c] of segs) {
        const e = /** @type {{ originalSource: string, originalLine: number, originalColumn: number }} */ (node.findEntry(line, col))
        assert.deepEqual([path.basename(e.originalSource), e.originalLine, e.originalColumn], [path.basename(/** @type {string} */ (payload.sources[src])), l, c])
      }
    })
  }
})

test('the command prints the source place and line, and says plainly what it cannot read', async () => {
  const call = positionOf('rust-review', 'nestedWorkflow(workflow,')
  const ok = await run(['rust-review', `workflow.js:${call.line}:${call.column}`], {})
  assert.equal(ok.exitCode, 0, ok.stderr.join('\n'))
  assert.match(ok.stdout[0] ?? '', /^src\/rust-review\.js:\d+:\d+$/)
  assert.equal((await run([], {})).exitCode, 2)
  assert.equal((await run(['rust-review', 'twelve'], {})).exitCode, 2)
  const banner = await run(['rust-review', '1:1'], {})
  assert.equal(banner.exitCode, 1)
  assert.match(banner.stderr.join('\n'), /maps to no source — the banner/)
  const none = await run(['no-such-engine', '1:1'], {})
  assert.match(none.stderr.join('\n'), /workflows\/no-such-engine\.js\.map is absent/)
})
