// Three engines refuse a `repo` argument, and the refusal has to be both ADVERTISED and RECORDED.
//
// Advertised: `review` names the argument loudly in its `whenToUse`, and a skill is selected by that
// text, so a caller reading the neighbouring descriptions has no way to learn that `rust-audit`,
// `triage-findings` and `adversarial-review` do not take it. They refuse correctly and say what to
// do instead — but only after being dispatched.
//
// Recorded: the refusal used to sit in the argument block, above `logRun` and everything it depends
// on, so it returned without filing a run record. `notRun` fragility ranking is the one place a
// REPEATED wrong dispatch would surface, and it never saw these at all. The check now sits between
// the logger's definition and the first phase — still before anything runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runEngine, filedRecord } from './engine-harness.mjs'

const ENGINES = ['rust-audit', 'triage-findings', 'adversarial-review']

for (const engine of ENGINES) {
  test(`${engine}: the repo refusal says so in whenToUse`, () => {
    const src = fs.readFileSync(new URL(`../workflows/${engine}.js`, import.meta.url), 'utf8')
    const m = src.match(/whenToUse: '([^']*(?:\\'[^']*)*)'/)
    assert.ok(m, 'whenToUse found')
    assert.match(m[1], /repo/, 'the argument the engine refuses is named where a caller reads before dispatching')
  })

  test(`${engine}: the repo refusal files a run record with a rankable notRun class`, async () => {
    const run = await runEngine(engine, {
      args: { repo: '/some/other/repo' },
      script: { 'log-run': { ok: true, error: '' }, '*': null },
    })
    assert.match(run.report, /INCOMPLETE/, 'it still refuses, and says so')
    assert.ok(!run.calls.some(c => /^(scout|lens|plan|gather)/.test(String(c.label))),
      'and refuses before dispatching any work agent')
    const rec = filedRecord(run)
    assert.ok(rec, 'a refusal that files nothing is invisible to the fragility ranking')
    const nr = (rec.notRun || []).join('\n')
    assert.match(nr, /repo/, 'the refusal is named in notRun')
    assert.ok(!/some\/other\/repo/.test(nr), 'as a class — notRun is ranked by exact string, so the caller\'s path stays out')
    assert.match(String(rec.verdict || ''), /INCOMPLETE/, 'and the record does not read as a completed run')
  })
}
