// Every place that launches a review engine teaches the post-run enrich-cost step, so each record a run
// files gets its real cost (realm @nick/craft, nodes #393, #403): an engine's `whenToUse` for a direct
// launch through the Workflow tool, and each skill that launches one.
import fs from 'node:fs'
import { test } from 'vitest'
import assert from 'node:assert/strict'

// The one sentence, wherever it is wrapped: any run of whitespace stands for a space.
const esc = (/** @type {string} */ t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+')
const SENTENCE = (/** @type {string} */ cmd) => new RegExp([
  '(?:' + ['a workflow run', 'a run of either', 'each engine run of this cycle', 'the `craft:review` or `craft:adversarial-review` run'].map(esc).join('|') + ')',
  esc('has ended (completed, failed or stopped — not while you may still resume it), fold its real cost into the records it filed:'),
  esc(cmd) + '[^,]*' + esc(', with the run id the Workflow completion names. Best-effort: if it fails, say so in one line and go on.'),
].join('\\s+'))
const ENGINE_CMD = '`node "<craft plugin root>/lib/craft-log-run.mjs" enrich-cost --run-id <wf_…>`'
const SKILL_CMD = '`node "<this skill\'s base directory>/../../lib/craft-log-run.mjs" enrich-cost --run-id <wf_…>`'

for (const engine of ['review', 'rust-audit', 'adversarial-review', 'triage-findings', 'rust-review', 'nix-review']) {
  test(`${engine}: whenToUse teaches enrich-cost after the run`, () => {
    const src = fs.readFileSync(`src/${engine}.js`, 'utf8')
    const whenToUse = String(src.match(/whenToUse: '((?:[^'\\]|\\.)*)'/)?.[1]).replace(/\\'/g, "'")
    assert.match(whenToUse, SENTENCE(ENGINE_CMD))
    assert.match(whenToUse, /\(the plugin root is two directories above a craft skill's base directory/,
      'the plugin root is named where a consumer can resolve it')
  })
}

for (const skill of ['rust-review', 'nix-review', 'develop', 'addressing-findings']) {
  test(`${skill}: the skill teaches enrich-cost after the run`, () => {
    assert.match(fs.readFileSync(`skills/${skill}/SKILL.md`, 'utf8'), SENTENCE(SKILL_CMD))
  })
}

test('addressing-findings: step 7\'s re-review teaches enrich-cost, not only triage', () => {
  const src = fs.readFileSync('skills/addressing-findings/SKILL.md', 'utf8')
  const step7 = src.slice(src.indexOf('7. Re-review'), src.indexOf('8. Close loop'))
  assert.match(step7, SENTENCE(SKILL_CMD))
})
