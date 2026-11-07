// What normalizeArgs SAYS when it repairs or drops the options: one loud warning per degradation,
// quoting a bounded prefix of what arrived. What it returns is pinned in workflow-args.test.mjs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { normalizeArgs } from './workflow-args.mjs'

const warnings = () => {
  /** @type {string[]} */
  const said = []
  return { warn: /** @param {unknown} m */ m => said.push(String(m)), said }
}

test('what cannot be understood drops the options LOUDLY, never quietly', () => {
  // The whole point. A run that quietly falls back to defaults produces a confident verdict about a
  // diff nobody asked for, and there is nothing in the report to notice.
  for (const bad of ['{"base": oops}', '[1,2,3]', '"just a string"']) {
    const w = warnings()
    assert.deepEqual(normalizeArgs(bad, w.warn), {})
    assert.equal(w.said.length, 1, `${bad}: must say it dropped the options`)
    assert.match(/** @type {string} */ (w.said[0]), /ignored|defaults/i)
  }
})

test('a JSON array or string holding key=value text never becomes options', () => {
  for (const bad of ['[base=v1]', '"base=v1"']) {
    const w = warnings()
    assert.deepEqual(normalizeArgs(bad, w.warn), {}, bad)
    assert.match(/** @type {string} */ (w.said[0]), /JSON value/, `${bad}: the JSON-value branch, not the key=value one`)
  }
})

test('the warnings quote a bounded prefix of what arrived', () => {
  const long = `[${'x'.repeat(60)}]`
  const w = warnings()
  normalizeArgs(long, w.warn)
  assert.ok(w.said[0]?.includes(`(${long.slice(0, 40)})`), w.said[0])
  const prose = `just words ${'y'.repeat(60)}`
  const w2 = warnings()
  normalizeArgs(prose, w2.warn)
  assert.equal(w2.said.length, 1, 'one warning, and it is the unrecognized one')
  assert.match(/** @type {string} */ (w2.said[0]), /unrecognized/)
  assert.ok(w2.said[0]?.includes(`(${prose.slice(0, 40)})`), w2.said[0])
})

test('a broken JSON object is reported with the parser\'s own message, bounded', () => {
  const bad = '{x'
  let message = ''
  try { JSON.parse(bad) } catch (e) { message = /** @type {Error} */ (e).message }
  const w = warnings()
  assert.deepEqual(normalizeArgs(bad, w.warn), {}, 'the options are dropped')
  assert.equal(w.said.length, 1, 'and that is said once')
  assert.ok(message.length > 60, 'the probe needs a parser message longer than the bound')
  assert.ok(w.said[0]?.includes(`(${message.slice(0, 60)})`), `the parser's message, cut at 60: ${w.said[0]}`)
})

test('the key=value repair is announced, and at most six ignored words are quoted', () => {
  const w = warnings()
  normalizeArgs('a=1 w1 w2 w3 w4 w5 w6 w7', w.warn)
  assert.equal(w.said.length, 2, 'the repair, then the ignored words')
  assert.match(/** @type {string} */ (w.said[0]), /key=value/)
  assert.match(/** @type {string} */ (w.said[1]), /\b7\b.*\(w1 w2 w3 w4 w5 w6\)/)
})
