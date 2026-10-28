// The Rust unit probe over the units CLI (lib/craft-units.mjs; realm @nick/craft, #377), executed: the prompt
// runs the CLI from the plugin with the prose commands as the fallback, the CLI's answer slices the change as
// the prose answer did, and the CLI's error is a failed probe (#362).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { manifestLine, unitsAnswer } from './cargo-units.mjs'
import { RUST_UNITS } from './rust-units.mjs'

/** @param {string} dir @param {number} n */
const rs = (dir, n) => Array.from({ length: n }, (_v, i) => `${dir}/f${i}.rs`)
const BIG = [...rs('crates/big/src/net', 3), ...rs('crates/big/src/db', 3)]
const FILES = [...rs('crates/a/src', 4), ...rs('crates/b/src', 4), ...rs('crates/x/src', 2), ...rs('crates/y/src', 2), ...BIG, 'Cargo.lock']
const NUMSTAT = FILES.map(f => `${BIG.includes(f) ? 300 : 5}\t${BIG.includes(f) ? 100 : 5}\t${f}`)
// The prose probe's answer as a model returned it: awk's dependency order, a field run of two spaces.
const PROSE = { roots: ['crates/a', 'crates/b', 'crates/big', 'crates/x', 'crates/y'], packages: ['@@ crates/a 900 12 a', '@@ crates/b 700 9 b serde  a', '@@ crates/big 50000 300 big', '@@ crates/x 80 2 x', '@@ crates/y 60 1 y-core'], numstat: NUMSTAT }
// The same workspace through the CLI's port of the awk (manifests as Cargo would have them; b renames a).
/** @type {Record<string, [number, number, string]>} */
const MANIFESTS = {
  a: [900, 12, '[package]\nname = "a"\n'],
  b: [700, 9, '[package]\nname = "b"\n\n[dependencies]\nserde = "1"\nmy-a = { path = "../a", package = "a" }\n'],
  big: [50000, 300, '[package]\nname = "big"\n'],
  x: [80, 2, '[package]\nname = "x"\n[workspace.dependencies]\nnot-a-dep = "1"\n'],
  y: [60, 1, '[package]\nname = "y-core"\n'],
}
const CLI = unitsAnswer(Object.entries(MANIFESTS).map(([d, [c, s, m]]) => ({ dir: `crates/${d}`, line: manifestLine(`crates/${d}`, c, s, m) })), `${NUMSTAT.join('\n')}\n`)

/** @param {string} label */
const lensOf = label => String(label).split(':')[2]?.split(' ')[0] || 'safety'
/** @param {Record<string, any>} units @returns {Record<string, any>} */
function script(units) {
  return {
    detect: { baseRef: 'main', files: FILES, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'concurrency', 'tests', 'intent'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    units,
    coord: { answered: 0, unanswered: 0, notes: '' },
    'coord-stop': { written: true },
    seam: { findings: [], dispositions: [], answered: 0 },
    lens: (/** @type {{ opts: any }} */ { opts }) => ({ lens: lensOf(opts.label), findings: [] }),
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
  }
}
/** @typedef {import('./engine-harness.mjs').Call} Call */
/** The run's agents but the probe and the record write, label and prompt. @param {Call[]} calls */
const dispatch = calls => calls.filter(c => !/^units:|^log-run$/.test(String(c.label))).map(c => [c.label, c.prompt])
const ARGS = { unitScope: true, unitBatchBudget: 1500, base: 'main' }

test('the CLI\'s answer slices the change exactly as the prose probe\'s answer did', async () => {
  const prose = await runEngine('review', { args: ARGS, script: script(PROSE) })
  const cli = await runEngine('review', { args: ARGS, script: script(CLI) })
  assert.ok(prose.calls.some(c => /^lens:rust:tests r1 unit:crates\/a unit:crates\/b$/.test(String(c.label))), 'the change is sliced by unit batches')
  assert.deepEqual(dispatch(cli.calls), dispatch(prose.calls), 'the same agents with the same prompts')
  assert.deepEqual(filedRecord(cli).unitNotices, [])
})

test('the probe prompt runs the shipped CLI located like the logger, the prose commands only when no copy qualifies', async () => {
  const run = await runEngine('review', { args: { ...ARGS, craftRoot: '/opt/craft' }, script: script(CLI) })
  const probe = run.calls.find(c => /^units:rust/.test(String(c.label)))
  const prompt = String(probe?.prompt)
  assert.match(prompt, /CRAFT_TRY='\/opt\/craft'"\/lib\/craft-units\.mjs"/, 'craftRoot first')
  assert.match(prompt, /"\$\{CLAUDE_PLUGIN_ROOT:-\}\/lib\/craft-units\.mjs"/, 'then CLAUDE_PLUGIN_ROOT')
  assert.match(prompt, /plugins\/cache\/craft\/craft\/"'[^']+'"\/lib\/craft-units\.mjs"/, 'then this version\'s cached copy')
  assert.match(prompt, /node "\$CRAFT_UNITS" --merge-base 'main'/, 'the CLI gets the lens diff range')
  assert.match(prompt, /B\. Otherwise \(it printed `CRAFT_UNITS: no usable copy`, a JSON object with an "error", or nothing\)/, 'the prose fallback, after a CLI error too')
  assert.ok(prompt.includes(RUST_UNITS.probePrompt("--merge-base 'main'").split('\n').slice(1).join('\n')), 'the prose commands as before')
  assert.equal(probe?.opts?.model, 'haiku')
  assert.equal(probe?.opts?.effort, 'low')
})

test('the probe without the plugin\'s place is the prose prompt alone, as before', () => {
  const prose = RUST_UNITS.probePrompt('HEAD')
  assert.doesNotMatch(prose, /craft-units/)
  assert.match(prose, /^List the Cargo packages of this repository and the diff's line counts\. Change nothing\. Run each command below ONCE/)
  assert.match(prose, /2\. Changed lines: `git diff --numstat --no-renames HEAD`/)
})

test('the CLI\'s error is a failed probe: the notice carries its text, the review runs in the normal mode', async () => {
  const run = await runEngine('review', { args: ARGS, script: script({ roots: [], error: 'git ls-files: not found on PATH' }) })
  const line = 'Unit mode skipped, the crate probe failed on the Rust change (answered an error: git ls-files: not found on PATH) — the review ran in the normal mode.'
  assert.ok(run.report.includes(`⚠️ ${line}`))
  assert.deepEqual(filedRecord(run).unitNotices, [line])
  assert.doesNotMatch(filedRecord(run).verdict, /INCOMPLETE/)
})
