// Reading a built engine's position back to its source (lib/engine-source-map.mjs): the VLQ decoding by hand,
// and the real bundled pins, whose positions must land on the very token in src/ or lib/.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { SourceMap } from 'node:module'
import path from 'node:path'
import { decodeMappings, decodeVlq, locate, originalPosition, run } from './engine-source-map.mjs'
import { fileLine, metaSpan } from './harness-lines.mjs'
import { ROOT } from './repo-root.mjs'
import { authoredText } from './engine-harness.mjs'

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

// The real bundles and the files their maps name, as written, in a tree of their own: an in-place mutation run
// rewrites the checkout's copies (lib/engine-harness.mjs, authoredText), and these places are lines of the originals.
const ENGINES = ['nix-review', 'rust-review']
const AUTHORED = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-source-map-real-'))
for (const engine of ENGINES) {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', `${engine}.js.map`), 'utf8'))
  for (const rel of [`workflows/${engine}.js`, `workflows/${engine}.js.map`, ...map.sources.map((/** @type {string} */ s) => path.posix.join('workflows', s))]) {
    fs.mkdirSync(path.dirname(path.join(AUTHORED, rel)), { recursive: true })
    fs.writeFileSync(path.join(AUTHORED, rel), authoredText(rel))
  }
}
afterAll(() => fs.rmSync(AUTHORED, { recursive: true, force: true }))

/** The 1-based line and column of the first `needle` in workflows/<engine>.js. @param {string} engine @param {string} needle */
function positionOf(engine, needle) {
  const lines = fs.readFileSync(path.join(AUTHORED, 'workflows', `${engine}.js`), 'utf8').split('\n')
  const line = lines.findIndex(l => l.includes(needle))
  return { line: line + 1, column: /** @type {string} */ (lines[line]).indexOf(needle) + 1 }
}

for (const [engine, lang] of /** @type {[string, string][]} */ ([['nix-review', 'nix'], ['rust-review', 'rust']])) {
  test(`${engine}: a position in the bundle reads back to the engine's own line, and to lib/ for bundled code`, () => {
    const call = positionOf(engine, 'nestedWorkflow(workflow,')
    const at = locate(AUTHORED, engine, call.line, call.column)
    assert.equal(at.file, `src/${engine}.js`)
    assert.match(/** @type {string} */ (at.text), new RegExp(`return await nestedWorkflow\\(workflow, 'review', .*languages: \\['${lang}'\\]`))
    const src = fs.readFileSync(path.join(AUTHORED, at.file), 'utf8').split('\n')[at.line - 1]
    assert.equal(src?.slice(at.column - 1).startsWith('nestedWorkflow('), true, 'the very token')
    const lib = positionOf(engine, 'unresolved(e2)')
    const inLib = locate(AUTHORED, `craft:${engine}`, lib.line, lib.column)
    assert.equal(inLib.file, 'lib/nested-workflow.mjs')
    assert.match(/** @type {string} */ (inLib.text), /if \(unresolved\(e2\)\)/)
  })
}

test('every segment of the shipped maps decodes as Node\'s own source-map reader decodes it', () => {
  for (const engine of ENGINES) {
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
  const ok = await run(['rust-review', `${call.line}:${call.column}`], {}, AUTHORED)
  assert.equal(ok.exitCode, 0, ok.stderr.join('\n'))
  assert.match(ok.stdout[0] ?? '', /^src\/rust-review\.js:\d+:\d+$/)
  assert.equal((await run([], {})).exitCode, 2)
  assert.equal((await run(['rust-review', 'twelve'], {})).exitCode, 2)
  const banner = await run(['rust-review', '1:1'], {}, AUTHORED)
  assert.equal(banner.exitCode, 1)
  assert.match(banner.stderr.join('\n'), /maps to no source — the banner/)
  const none = await run(['no-such-engine', '1:1'], {})
  assert.match(none.stderr.join('\n'), /workflows\/no-such-engine\.js\.map is absent/)
})

// The harness numbers lines with the meta statement cut out and one wrapper line in its place (realm #348).
const SHAPE = [
  'export const meta = {',
  "  name: 'x',",
  "  description: 'a } and a { in a string, `and` \\' quotes',",
  "  phases: [{ title: 'T', detail: \"d}\" }],",
  '};',
  'function body(){return 1}',
  'return await __run();',
].join('\n')

test('the meta statement spans its lines, braces and quotes inside its strings included', () => {
  assert.deepEqual(metaSpan(SHAPE), { start: 1, end: 5 })
  assert.deepEqual(metaSpan(`// lead\n${SHAPE}`), { start: 2, end: 6 })
  assert.equal(metaSpan('function f(){}'), null)
  assert.deepEqual(metaSpan("export const meta = { // a } here\n  a: 1, /* } */\n}\nx()"), { start: 1, end: 3 }, 'comments are skipped')
})

test('a harness line after meta is the file line shifted by the meta lines less the wrapper line', () => {
  assert.equal(fileLine(SHAPE, 2), 6, 'the body line right after a five-line meta')
  assert.equal(fileLine(SHAPE, 3), 7)
  assert.equal(fileLine(SHAPE, 1), null, 'the wrapper line that stands in for meta')
  assert.equal(fileLine(`// lead\n${SHAPE}`, 1), 1, 'a line before meta is not shifted')
  assert.equal(fileLine('function f(){}', 1), 1, 'no meta, no shift')
})

test('a workflow.js: position is the harness numbering of the real bundle; a bare one is the file numbering', async () => {
  const body = fs.readFileSync(path.join(AUTHORED, 'workflows', 'nix-review.js'), 'utf8')
  const span = /** @type {{ start: number, end: number }} */ (metaSpan(body))
  assert.ok(span.end - span.start >= 1, 'nix-review ships a multi-line meta')
  const call = positionOf('nix-review', 'unresolved(e2)')
  assert.ok(call.line > span.end, 'the probed code sits after meta')
  const harness = call.line - (span.end - span.start)
  const viaHarness = await run(['nix-review', `workflow.js:${harness}:${call.column}`], {}, AUTHORED)
  const viaFile = await run(['nix-review', `${call.line}:${call.column}`], {}, AUTHORED)
  assert.equal(viaHarness.exitCode, 0, viaHarness.stderr.join('\n'))
  assert.deepEqual(viaHarness.stdout, viaFile.stdout)
  assert.match(viaHarness.stdout[0] ?? '', /^lib\/nested-workflow\.mjs:\d+:\d+$/)
  const wrapper = await run(['nix-review', `workflow.js:${span.start}:1`], {}, AUTHORED)
  assert.equal(wrapper.exitCode, 1)
  assert.match(wrapper.stderr.join('\n'), /stands in for meta/)
})

// A map-less engine — one built with SOURCE_MAPS off ships none (realm @nick/craft, #348) — in a checkout of
// its own: a multi-line meta, a short line and one of hundreds of characters.
function mapLessRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-map-less-'))
  fs.mkdirSync(path.join(root, 'workflows'))
  const body = [
    'export const meta = {', "  name: 'fenced',", "  description: 'a fenced engine',", '}', '',
    '/** @param {string} text */', 'function parseOptions(text) {', '  return text.trim()', '}',
    `const LONG = '${'x'.repeat(400)}'`, 'return parseOptions(LONG)', '',
  ].join('\n')
  fs.writeFileSync(path.join(root, 'workflows', 'fenced.js'), body)
  return { root, body }
}

/** The 1-based line and column of the first `needle` in `body`. @param {string} body @param {string} needle */
function positionIn(body, needle) {
  const lines = body.split('\n')
  const line = lines.findIndex(l => l.includes(needle))
  return { line: line + 1, column: /** @type {string} */ (lines[line]).indexOf(needle) + 1 }
}

test('a map-less engine is pointed at its own shifted file line, with that line\'s text', async () => {
  const { root, body } = mapLessRoot()
  try {
    assert.equal(fs.existsSync(path.join(root, 'workflows', 'fenced.js.map')), false, 'the engine ships no map')
    const span = /** @type {{ start: number, end: number }} */ (metaSpan(body))
    assert.ok(span.end - span.start >= 1, 'a multi-line meta')
    const call = positionIn(body, 'parseOptions(text)')
    const harness = call.line - (span.end - span.start)
    const viaHarness = await run(['fenced', `workflow.js:${harness}:${call.column}`], {}, root)
    assert.equal(viaHarness.exitCode, 0, viaHarness.stderr.join('\n'))
    assert.equal(viaHarness.stdout[0], `workflows/fenced.js:${call.line}:${call.column}`)
    assert.equal((viaHarness.stdout[1] ?? '').includes('function parseOptions(text)'), true, 'the line around the column')
    assert.match(viaHarness.stdout.join('\n'), /no source map ships for workflows\/fenced\.js/)
    const viaFile = await run(['craft:fenced', `${call.line}:${call.column}`], {}, root)
    assert.deepEqual(viaFile.stdout, viaHarness.stdout)
    const wrapper = await run(['fenced', `workflow.js:${span.start}:1`], {}, root)
    assert.equal(wrapper.exitCode, 1)
    assert.match(wrapper.stderr.join('\n'), /stands in for meta/)
    const past = await run(['fenced', `${body.split('\n').length + 5}:1`], {}, root)
    assert.equal(past.exitCode, 1)
    assert.match(past.stderr.join('\n'), /past the end of workflows\/fenced\.js/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a long line is cut to a window around the column', async () => {
  const { root, body } = mapLessRoot()
  try {
    const lines = body.split('\n')
    const at = lines.findIndex(l => l.length > 300)
    assert.ok(at >= 0, 'the engine has a long line')
    const line = /** @type {string} */ (lines[at])
    const column = Math.floor(line.length / 2)
    const out = await run(['fenced', `${at + 1}:${column}`], {}, root)
    assert.equal(out.exitCode, 0, out.stderr.join('\n'))
    const shown = out.stdout[1] ?? ''
    assert.ok(shown.length < 200, `cut: ${shown.length}`)
    assert.match(shown, /^ {2}….*…$/)
    assert.equal(shown.includes(line.slice(column - 1, column + 20)), true, 'the column is inside the window')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
