// enrich-cost counts a model message once (realm @nick/craft, node #357): the harness writes one
// assistant message as several transcript lines that share `message.id` and repeat its usage.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sumTranscriptUsage, enrichCost } from './craft-log-run.mjs'
import { COST_RULE, COST_RULE_PER_LINE, costProblem } from './run-record.mjs'

/** @param {string | undefined} id @param {number} out */
const line = (id, out) => JSON.stringify({ type: 'assistant', message: { ...(id ? { id } : {}),
  usage: { input_tokens: 2, output_tokens: out, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 } } })

test('sumTranscriptUsage counts the lines of one message once', () => {
  const text = [line('msg_a', 5), line('msg_a', 5), line('msg_a', 5), line('msg_b', 1), line('msg_b', 1)].join('\n')
  assert.deepEqual(sumTranscriptUsage(text), { output: 6, input: 4, cacheRead: 2000, cacheWrite: 20 })
})

test('sumTranscriptUsage takes the largest count a message\'s lines carry, wherever the lines fall', () => {
  // Observed on Claude Code 2.1.309, 400 local workflow transcripts (2026-10-28): 163 of 8259 lines carried a
  // larger output_tokens than an earlier line of the same message (realm @nick/craft, node #98).
  const text = [line('msg_a', 1), line('msg_b', 3), line('msg_a', 7)].join('\n')
  assert.deepEqual(sumTranscriptUsage(text), { output: 10, input: 4, cacheRead: 2000, cacheWrite: 20 })
})

test('sumTranscriptUsage still counts every line that carries no message id', () => {
  assert.deepEqual(sumTranscriptUsage([line(undefined, 1), line(undefined, 1)]), { output: 2, input: 4, cacheRead: 2000, cacheWrite: 20 })
})

test('enrichCost names the counting rule on the cost it writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cost-'))
  try {
    fs.writeFileSync(path.join(dir, 'agent-a.jsonl'), [line('msg_a', 5), line('msg_a', 5)].join('\n') + '\n')
    const recordFile = path.join(dir, 'rec.json')
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1 }))
    const { cost } = enrichCost({ runDir: dir, recordFile, warnings: [] })
    assert.equal(cost.rule, COST_RULE)
    assert.equal(cost.output, 5)
    assert.equal(JSON.parse(fs.readFileSync(recordFile, 'utf8')).cost.rule, COST_RULE)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('enrichCost does not name the per-message rule when usage lines carry no message id, and warns', () => {
  // The id is the harness's to keep (realm @nick/craft, node #98): lost, every line counts alone again.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-cost-'))
  try {
    fs.writeFileSync(path.join(dir, 'agent-a.jsonl'), [line('msg_a', 5), line(undefined, 5)].join('\n') + '\n')
    const recordFile = path.join(dir, 'rec.json')
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1 }))
    /** @type {string[]} */
    const warnings = []
    const { cost } = enrichCost({ runDir: dir, recordFile, warnings })
    assert.equal(cost.rule, COST_RULE_PER_LINE)
    assert.equal(costProblem(cost), 'overcounted')
    assert.match(warnings.join('\n'), /1 usage line\(s\) without a message id/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('costProblem: no rule or the per-line rule is overcounted, an unknown rule is its own class, a non-string rule malformed', () => {
  const parts = { output: 1, input: 1, cacheRead: 1, cacheWrite: 1, total: 4, agents: 1, source: 'r' }
  assert.equal(costProblem({ ...parts }), 'overcounted')
  assert.equal(costProblem({ ...parts, rule: COST_RULE }), null)
  assert.equal(costProblem({ ...parts, rule: 7 }), 'malformed')
  assert.equal(costProblem({ ...parts, rule: COST_RULE_PER_LINE }), 'overcounted')
  assert.equal(costProblem({ ...parts, rule: 'per-turn' }), 'unknown-rule')
})
