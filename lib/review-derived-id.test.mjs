// A record without an id: the engine derives it by the memory skill's rule when the record carries
// kind, title and scope, and still refuses one that lacks them (realm @nick/craft, node #222). The
// consumer case (realm @nick/craft, node #217): a launcher hand-built ten priorDecisions without an id and
// the engine refused every one.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { memoryLine, withDerived } from './memory-recall.mjs'

test('withDerived/memoryLine: the derived count closes every form of the line, and nothing is said when none was derived', () => {
  const long = 'a title long enough to be cut at the bound of the line'
  const two = [{ id: 'decision-a', title: 't1', derived: true }, { id: 'x', title: 'x' }, { id: 'decision-b', title: long, derived: true }]
  const tail = `id derived for 2 record(s): decision-a (t1), decision-b (${long.slice(0, 40)}…)`
  assert.equal(memoryLine(withDerived({ source: 'recalled', count: 3, why: 'repo (w)' }, two)), `memory: recalled 3 decision(s) from repo (w); ${tail}`)
  assert.equal(memoryLine(withDerived({ source: 'none', count: 0, why: 'w', passed: 2 }, two)), `memory: none — w; plus 2 passed by the launcher; ${tail}`)
  assert.equal(memoryLine(withDerived({ source: 'launcher', count: 3, why: '' }, two)), `memory: recalled by the launching audit — applied 3 decision(s); ${tail}`)
  assert.deepEqual(withDerived({ source: 'none', count: 0, why: 'w' }, [{ id: 'x', title: 'x' }]), { source: 'none', count: 0, why: 'w' })
})
