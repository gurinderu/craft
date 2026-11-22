// costProblem: which stored costs a reader takes as usable — the rule a cost was counted by (realm @nick/craft,
// node #357) and a slice of a run (node #393). The counting itself is the binary's (cli/crates/craft-store/src/cost/).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { COST_RULE, COST_RULE_PER_LINE, costProblem } from './run-record.mjs'

test('costProblem: no rule or the per-line rule is overcounted, an unknown rule is its own class, a non-string rule malformed', () => {
  const parts = { output: 1, input: 1, cacheRead: 1, cacheWrite: 1, total: 4, agents: 1, source: 'r' }
  assert.equal(costProblem({ ...parts }), 'overcounted')
  assert.equal(costProblem({ ...parts, rule: COST_RULE }), null)
  assert.equal(costProblem({ ...parts, rule: 7 }), 'malformed')
  assert.equal(costProblem({ ...parts, rule: COST_RULE_PER_LINE }), 'overcounted')
  assert.equal(costProblem({ ...parts, rule: 'per-turn' }), 'unknown-rule')
})

test('costProblem: a slice of a run is a usable cost; a slice of the wrong shape is malformed', () => {
  const parts = { output: 1, input: 1, cacheRead: 1, cacheWrite: 1, total: 4, agents: 1, source: 'wf_r', rule: COST_RULE }
  assert.equal(costProblem({ ...parts, slice: { index: 2, of: 2, tail: 3 } }), null)
  for (const slice of [{ index: 0, of: 1 }, { index: 2, of: 1 }, { index: 1, of: 1, tail: -1 }, { index: '1', of: 1 }, [1], 'x']) {
    assert.equal(costProblem({ ...parts, slice }), 'malformed', JSON.stringify(slice))
  }
})
