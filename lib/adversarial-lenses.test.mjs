// The general profile the CLI reads as data (content/profiles/general.json) held to the adversarial review's catalog
// (lib/adversarial-lenses.mjs): the same seven lenses in the same order, each brief the same file.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import general from '../content/profiles/general.json' with { type: 'json' }
import { LENS_BRIEF } from './adversarial-lenses.mjs'
import { contentText } from './content.mjs'

/** @param {string} name */
const prompt = name => contentText(readFileSync(new URL(`../content/prompts/${name}.md`, import.meta.url), 'utf8'))

test('the general profile runs the adversarial review\'s lenses, brief by brief', () => {
  assert.deepEqual(general.lenses.map(l => l.id), Object.keys(LENS_BRIEF))
  for (const l of general.lenses) assert.equal(prompt(l.brief), LENS_BRIEF[l.id], l.id)
  assert.deepEqual(general.floorLenses, [], 'no floor lens: the catalog has none')
  assert.ok(general.detect.rest, 'it takes every file carrying code no other profile takes')
  assert.ok(!('lensAgent' in general), 'the engine runs its finder lenses on the default agent')
})
