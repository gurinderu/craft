import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mutationScore } from './mutation-score.mjs'

/** @param {string[]} statuses @returns {{ files: Record<string, { mutants: { status: string }[] }> }} */
const report = statuses => ({ files: { 'lib/a.mjs': { mutants: statuses.map(status => ({ status })) } } })

test('mutationScore: killed and timed-out over every valid mutant, as Stryker scores it', () => {
  // 2 detected of 4 valid (Survived, NoCoverage count against); Ignored and errors are left out.
  const r = report(['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored', 'CompileError', 'RuntimeError'])
  assert.equal(mutationScore(r), 50)
})

test('mutationScore: mutants across files are pooled', () => {
  const r = { files: { a: { mutants: [{ status: 'Killed' }] }, b: { mutants: [{ status: 'Survived' }, { status: 'Survived' }, { status: 'Killed' }] } } }
  assert.equal(mutationScore(r), 50)
})

test('mutationScore: no report shape or no valid mutant is null, not a score', () => {
  for (const bad of [null, {}, { files: [] }, { files: { a: {} } }, report([]), report(['Ignored'])]) {
    assert.equal(mutationScore(bad), null, JSON.stringify(bad))
  }
})
