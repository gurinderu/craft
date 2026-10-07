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
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runEngine, filedRecord } from './engine-harness.mjs'

const ENGINES = ['rust-audit', 'triage-findings', 'adversarial-review']
const CRAFT_VERSION = fs.readFileSync(new URL('../src/review.js', import.meta.url), 'utf8').match(/^const CRAFT_VERSION = '([^']+)'/m)?.[1]

for (const engine of ENGINES) {
  test(`${engine}: the repo refusal says so in whenToUse`, () => {
    const src = fs.readFileSync(new URL(`../workflows/${engine}.js`, import.meta.url), 'utf8')
    const m = src.match(/whenToUse: '([^']*(?:\\'[^']*)*)'/)
    assert.ok(m, 'whenToUse found')
    assert.match(/** @type {string} */ (m[1]), /repo/, 'the argument the engine refuses is named where a caller reads before dispatching')
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

// The refusal is one helper (lib/run-record.mjs, repoRefusal) inlined into the three engines; what
// each engine files and returns is pinned whole here, so the helper cannot drift any one of them.
/** @param {string} engine @param {boolean} nested @param {string | null} via */
const refusedRecord = (engine, nested, via) => ({
  schemaVersion: 1, runtime: 'claude-code', craftVersion: CRAFT_VERSION, kind: 'workflow', name: engine,
  nested, via,
  verdict: 'INCOMPLETE (repo not supported)', findings: { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } },
  dimensions: [], verification: null,
  notRun: ['`repo` argument refused — this engine reviews only the session\'s own checkout'],
  outputTokens: 0,
})
/** @param {string} engine */
const refusedReport = engine => [
  `## Verdict`,
  `⚠️ INCOMPLETE — \`repo=/some/other/repo\` was given, but \`${engine}\` does not support reviewing a repository other than the one this session runs in: its agents would read THIS checkout and report a normal-looking verdict for the wrong code. Nothing ran.`,
  ``,
  `Either run \`craft:review\` with \`repo=\` (that engine threads a working-directory directive through its prompts), or start a session inside that repository and run \`${engine}\` there.`,
].join('\n')
const REFUSED = { 'log-run': { ok: true, error: '' }, '*': null }

for (const engine of ENGINES) {
  test(`${engine}: the refusal files exactly the refusal record and returns exactly the refusal text`, async () => {
    const run = await runEngine(engine, { args: { repo: '/some/other/repo' }, script: REFUSED })
    assert.deepEqual(filedRecord(run), refusedRecord(engine, false, null))
    assert.equal(run.report, refusedReport(engine))
    assert.equal(run.calls.length, 1, 'the record write is the only dispatch')
  })
}

test('adversarial-review: a nested refusal records the parent it was dispatched by', async () => {
  const run = await runEngine('adversarial-review', { args: { repo: '/some/other/repo', _via: 'rust-audit' }, script: REFUSED })
  assert.deepEqual(filedRecord(run), refusedRecord('adversarial-review', true, 'rust-audit'))
})
