import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseFrontmatter, lintSkill, lintAgent, extractCraftRefs, unresolvedRefs, extractForeignRefs,
  collectMdFiles, foreignDependencies, extractRelMdLinks,
} from './check-skills.mjs'

test('parseFrontmatter reads inline scalars', () => {
  const keys = parseFrontmatter('---\nname: rust-reviewer\nmodel: opus\n---\nbody')
  assert.equal(keys.get('name'), 'rust-reviewer')
  assert.equal(keys.get('model'), 'opus')
})

test('parseFrontmatter collapses a folded block scalar into one string', () => {
  const keys = parseFrontmatter('---\nname: x\ndescription: >-\n  first line\n  second line\n---\n')
  assert.equal(keys.get('name'), 'x')
  assert.equal(keys.get('description'), 'first line second line')
})

test('parseFrontmatter does not mistake a colon inside folded text for a new key', () => {
  const keys = parseFrontmatter('---\nname: x\ndescription: >-\n  Triggers: review, audit\n---\n')
  assert.equal(keys.get('description'), 'Triggers: review, audit')
})

test('parseFrontmatter returns null with no frontmatter', () => {
  assert.equal(parseFrontmatter('# just a heading\n'), null)
})

test('lintSkill is clean on a well-formed skill', () => {
  assert.deepEqual(lintSkill('rust-review', parseFrontmatter('---\nname: rust-review\ndescription: >-\n  ok\n---\n')), [])
})

test('lintSkill flags a name that disagrees with its directory', () => {
  const errs = lintSkill('rust-review', parseFrontmatter('---\nname: rust-reviu\ndescription: ok\n---\n'))
  assert.equal(errs.length, 1)
  assert.match(errs[0], /!= dir/)
})

test('lintSkill flags a missing description and missing frontmatter', () => {
  assert.deepEqual(lintSkill('x', parseFrontmatter('---\nname: x\n---\n')), ['missing/empty description'])
  assert.deepEqual(lintSkill('x', null), ['no frontmatter block'])
})

test('lintAgent requires name/description/tools/model', () => {
  assert.deepEqual(lintAgent('rust-reviewer', parseFrontmatter('---\nname: rust-reviewer\ndescription: d\ntools: ["Read"]\nmodel: opus\n---\n')), [])
  const errs = lintAgent('rust-reviewer', parseFrontmatter('---\nname: rust-reviewer\ndescription: d\n---\n'))
  assert.deepEqual(errs, ['missing tools', 'missing model'])
})

test('extractCraftRefs pulls every craft: slug, deduped', () => {
  const refs = extractCraftRefs('see craft:rust-reviewer and craft:rust-miri and craft:rust-reviewer again')
  assert.deepEqual([...refs].sort(), ['rust-miri', 'rust-reviewer'])
})

test('unresolvedRefs returns only the ids absent from the known set', () => {
  const known = new Set(['rust-review', 'rust-reviewer'])
  assert.deepEqual(unresolvedRefs(new Set(['rust-reviewer', 'ghost']), known), ['ghost'])
  assert.deepEqual(unresolvedRefs(new Set(['rust-review']), known), [])
})

test('extractForeignRefs flags refs to a forbidden plugin, deduped and sorted', () => {
  const foreign = new Set(['superpowers'])
  const text = 'see superpowers:verification-before-completion and superpowers:receiving-code-review and superpowers:verification-before-completion'
  assert.deepEqual(extractForeignRefs(text, foreign),
    ['superpowers:receiving-code-review', 'superpowers:verification-before-completion'])
})

test('extractForeignRefs ignores craft: refs and Rust :: paths', () => {
  const foreign = new Set(['superpowers'])
  assert.deepEqual(extractForeignRefs('craft:rust-review uses Result::Ok and https://x.dev', foreign), [])
})

test('collectMdFiles recurses into subdirectories, so a foreign ref in a nested sub-file is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-skill-'))
  try {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# ok, no foreign refs\n')
    fs.mkdirSync(path.join(dir, 'reference'))
    fs.writeFileSync(path.join(dir, 'reference', 'deep.md'), 'see superpowers:executing-plans\n')
    const files = collectMdFiles(dir)
    assert.ok(files.some(f => f.endsWith(path.join('reference', 'deep.md'))), 'walks nested dirs')
    const hits = files.flatMap(f => extractForeignRefs(fs.readFileSync(f, 'utf8'), new Set(['superpowers'])))
    assert.deepEqual(hits, ['superpowers:executing-plans'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extractRelMdLinks returns relative .md targets, ignoring URLs, anchors, and non-md', () => {
  const text = 'see [a](techniques.md) and [b](sub/core.md#part) and [c](https://x.dev/y.md) and [d](../rust.md) and [e](api-design)'
  assert.deepEqual(extractRelMdLinks(text), ['../rust.md', 'sub/core.md', 'techniques.md'])
})

test('foreignDependencies flags a forbidden dep in either the plugin.json or a marketplace entry', () => {
  const foreign = new Set(['superpowers'])
  assert.deepEqual(foreignDependencies({ dependencies: ['superpowers@claude-plugins-official'] }, foreign),
    ['superpowers@claude-plugins-official'])
  assert.deepEqual(foreignDependencies({ plugins: [{ dependencies: ['superpowers'] }] }, foreign), ['superpowers'])
  assert.deepEqual(foreignDependencies({ dependencies: ['some-other-plugin@x'] }, foreign), [])
  assert.deepEqual(foreignDependencies({}, foreign), [])
})
