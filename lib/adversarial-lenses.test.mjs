// The general profile the CLI reads as data (content/profiles/general.json) held to the adversarial review's catalog
// (lib/adversarial-lenses.mjs): the shared lenses in the engine's order, each brief the same file; complexity, whose
// metrics gate only the engine has, is the engine's alone.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import general from '../content/profiles/general.json' with { type: 'json' }
import { LENS_BRIEF, SHARED_LENS_BRIEF } from './adversarial-lenses.mjs'
import { contentText } from './content.mjs'

/** @param {string} name */
const prompt = name => contentText(readFileSync(new URL(`../content/prompts/${name}.md`, import.meta.url), 'utf8'))

test('the general profile runs the adversarial review\'s shared lenses, brief by brief, and not complexity', () => {
  assert.deepEqual(general.lenses.map(l => l.id), Object.keys(SHARED_LENS_BRIEF))
  for (const l of general.lenses) assert.equal(prompt(l.brief), SHARED_LENS_BRIEF[l.id], l.id)
  assert.deepEqual(Object.keys(LENS_BRIEF), [...Object.keys(SHARED_LENS_BRIEF), 'complexity'], 'the engine keeps its whole catalog')
  assert.ok(!general.lenses.some(l => l.id === 'complexity'))
})
