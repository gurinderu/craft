// The memory's prompts that triage-findings keeps rendering — the memory recall's, and the match and rule judges' over
// their record–finding pairs — held to the Rust CLI's (cli/crates/craft-review/src/memory/parity.rs) by one shared file,
// content/parity/judge-prompt-cases.json, which this test writes and the CLI reads. A changed template fails both sides
// until the file is regenerated: `UPDATE_JUDGE_PROMPT_PARITY=1 npx vitest run lib/judge-prompt-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { judgePrompt } from './prior-decision-match.mjs'
import { ruleJudgePrompt } from './project-rule-judge.mjs'
import { memoryRecallPrompt } from './memory-recall.mjs'

const FILE = new URL('../content/parity/judge-prompt-cases.json', import.meta.url)

const INPUT = {
  base: 'origin/main',
  // The paths the memory recall is asked for.
  recallPaths: ['src/lib.rs', 'flake.nix'],
  // The match judge's record–finding pairs: a decision and a deferred question, model text with newlines, runs of
  // spaces, quotes and a body past the judge's bound; a gate tool's finding naming its rule.
  judgePairs: [
    {
      record: { kind: 'decision', id: 'decision-0123456789', title: 'unwrap on a\nchecked   value', scope: 'src/lib.rs', line: 10, lens: 'errors', toolRule: '' },
      finding: { severity: 'Medium', title: ' unwrap of "x" ', file: 'src/lib.rs', line: 12, source: 'errors', sources: ['errors', 'tests'], why: `${'w '.repeat(450)}end` },
    },
    {
      record: { kind: 'question', id: 'question-0123456789', title: 'retry budget', scope: 'src', line: 0, lens: '', toolRule: 'clippy::needless_pass_by_value' },
      finding: { severity: 'Low', title: 'retry budget is unbounded', file: 'src/net.rs', line: 0, source: 'clippy', toolRule: 'clippy::needless_pass_by_value', why: 'é — ü <tag>' },
    },
  ],
  // The rule judge's pairs: a project rule narrowed to a lens, and one over the whole repository.
  rulePairs: [
    {
      rule: { kind: 'rule', id: 'rule-0123456789', title: 'we do not support\nrollback', scope: '.', lens: 'compat, errors' },
      finding: { severity: 'High', title: 'no rollback path', file: 'src/lib.rs', line: 3, source: 'compat', why: 'a failed upgrade cannot go back' },
    },
    {
      rule: { kind: 'rule', id: 'rule-9876543210', title: 'tests may unwrap', scope: 'tests', lens: '' },
      finding: { severity: 'Low', title: 'unwrap in a test', file: 'tests/a.rs', line: 9, source: 'errors', why: '' },
    },
  ],
}

/** What this engine renders for INPUT. */
function rendered() {
  return {
    memoryRecall: { paths: memoryRecallPrompt(INPUT.recallPaths, INPUT.base), none: memoryRecallPrompt([], INPUT.base) },
    matchJudge: judgePrompt(/** @type {never} */ (INPUT.judgePairs.map(p => ({ d: p.record, f: p.finding })))),
    ruleJudge: ruleJudgePrompt(/** @type {never} */ (INPUT.rulePairs.map(p => ({ r: p.rule, f: p.finding })))),
  }
}

test('the memory prompts the CLI is held to are the ones this engine renders', () => {
  const expected = rendered()
  if (process.env['UPDATE_JUDGE_PROMPT_PARITY']) writeFileSync(FILE, `${JSON.stringify({ input: INPUT, expected }, null, 2)}\n`)
  const file = JSON.parse(readFileSync(FILE, 'utf8'))
  assert.deepEqual(file.input, INPUT, 'the inputs both sides render')
  assert.deepEqual(file.expected, expected, 'regenerate with UPDATE_JUDGE_PROMPT_PARITY=1 after a template change')
})
