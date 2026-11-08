// The general profile the CLI reads as data (content/profiles/general.json) held to the adversarial review's catalog
// (lib/adversarial-lenses.mjs): the shared lenses in the engine's order, each brief the same file, then complexity,
// behind the code-metrics index in both, its prompt the one the engine renders.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import general from '../content/profiles/general.json' with { type: 'json' }
import { LENS_BRIEF, SHARED_LENS_BRIEF, complexityPrompt } from './adversarial-lenses.mjs'
import { contentText } from './content.mjs'

/** @param {string} name */
const prompt = name => contentText(readFileSync(new URL(`../content/prompts/${name}.md`, import.meta.url), 'utf8'))

test('the general profile runs the adversarial review\'s catalog, brief by brief, complexity behind the metrics index', () => {
  assert.deepEqual(general.lenses.map(l => l.id), Object.keys(LENS_BRIEF))
  assert.deepEqual(Object.keys(LENS_BRIEF), [...Object.keys(SHARED_LENS_BRIEF), 'complexity'], 'the engine keeps its whole catalog')
  for (const l of general.lenses.filter(l => l.id !== 'complexity')) assert.equal(prompt(l.brief), SHARED_LENS_BRIEF[l.id], l.id)
  const complexity = /** @type {{ brief: string, metrics?: boolean }} */ (general.lenses.find(l => l.id === 'complexity'))
  assert.equal(complexity.metrics, true, 'it runs only with a code-metrics index')
  assert.equal(complexityPrompt('`origin/main`'), prompt(complexity.brief).replace('{{base}}', '`origin/main`'))
})
