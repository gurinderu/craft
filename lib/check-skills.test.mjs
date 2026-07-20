import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFrontmatter, lintSkill, lintAgent, extractCraftRefs, unresolvedRefs,
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
