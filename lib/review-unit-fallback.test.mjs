// The review engine's unitScope mode where it has no units, executed (realm @nick/craft, #362): on a profile
// with no unit discovery, or with a discovery that finds no unit in the change, the review runs in the normal
// mode — the same dispatch as with the flag off — and the report and the record carry one warning line.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine, filedRecord } from './engine-harness.mjs'

/** @param {string} dir @param {string} ext @param {number} n */
const files = (dir, ext, n) => Array.from({ length: n }, (_v, i) => `${dir}/f${i}.${ext}`)

/** @typedef {import('./engine-harness.mjs').Call} Call */

/** @param {string[]} changed @param {Record<string, any>} [over] @returns {Record<string, any>} */
function script(changed, over = {}) {
  return {
    detect: { baseRef: 'main', files: changed, spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, error: '' },
    scout: { sizeBucket: 'small', lenses: ['safety', 'errors', 'tests', 'intent'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: (/** @type {{ opts: any }} */ { opts }) => ({ lens: String(opts.label).split(':')[2]?.split(' ')[0] || 'safety', findings: [] }),
    dedup: { groups: [] },
    synthesis: null,
    '*': null,
    ...over,
  }
}

/** The review agents of a run, label and prompt, with the calls `skip` names and the record write left out. @param {Call[]} calls @param {RegExp} [skip] */
const dispatch = (calls, skip = /^$/) => calls.filter(c => !skip.test(String(c.label)) && c.label !== 'log-run').map(c => [c.label, c.prompt])

test('unitScope on a profile with no unit discovery: the normal review, and one warning line in the report and the record', async () => {
  const nix = [...files('modules', 'nix', 8), ...files('hosts', 'nix', 6), 'flake.lock']
  const on = await runEngine('review', { args: { unitScope: true }, script: script(nix) })
  const off = await runEngine('review', { args: {}, script: script(nix) })
  assert.equal(on.calls.filter(c => /^(units|coord|coord-stop|seam):|^lens:\w+:contract/.test(String(c.label))).length, 0, 'no unit-mode agent runs')
  assert.deepEqual(dispatch(on.calls), dispatch(off.calls), 'the same agents with the same prompts as with the flag off')
  const line = 'Unit mode not available for Nix: its profile finds no units — the review ran in the normal mode.'
  assert.ok(on.report.includes(`⚠️ ${line}`), 'the report says why the mode did not run')
  assert.ok(!off.report.includes('Unit mode'), 'a run that did not ask for the mode says nothing of it')
  const rec = filedRecord(on)
  assert.equal(rec.unitScope, true)
  assert.deepEqual(rec.unitNotices, [line])
  assert.deepEqual(rec.unitCoordinator, [], 'no profile ran the mode')
  assert.doesNotMatch(rec.verdict, /INCOMPLETE/, 'a warning, never a failure')
})

test('unitScope on Rust with no crate in the change: the normal review after the probe, and one warning line', async () => {
  const rust = [...files('src', 'rs', 8), ...files('src/net', 'rs', 6), 'Cargo.lock']
  const on = await runEngine('review', { args: { unitScope: true }, script: script(rust, { units: { roots: [], packages: [], numstat: [] } }) })
  const off = await runEngine('review', { args: {}, script: script(rust) })
  assert.equal(on.calls.filter(c => /^units:rust/.test(String(c.label))).length, 1, 'the profile\'s probe runs')
  assert.deepEqual(dispatch(on.calls, /^units:/), dispatch(off.calls), 'beside the probe, the same agents with the same prompts as off')
  const line = 'Unit mode found no crate in the Rust change — the review ran in the normal mode.'
  assert.ok(on.report.includes(`⚠️ ${line}`))
  assert.deepEqual(filedRecord(on).unitNotices, [line])
})

// The slicer's "do not slice" (a small change, or one unit with unitBatches=false) is the same fallback as a
// profile with no units: the review dispatches as with the flag off — no contract, no seam, no coordinator.
test('unitScope on a Rust change too small to slice by unit: the normal review after the probe, and one warning line', async () => {
  const rust = [...files('crates/a/src', 'rs', 4), ...files('crates/b/src', 'rs', 3), 'Cargo.lock']
  const off = await runEngine('review', { args: {}, script: script(rust) })
  for (const args of [{ unitScope: true }, { unitScope: true, unitBatches: false }]) {
    const on = await runEngine('review', { args, script: script(rust, { units: { roots: ['crates/a', 'crates/b'], packages: [], numstat: [] } }) })
    assert.equal(on.calls.filter(c => /^(coord|coord-stop|seam):|^lens:\w+:contract/.test(String(c.label))).length, 0, 'no contract, seam or coordinator')
    assert.deepEqual(dispatch(on.calls, /^units:/), dispatch(off.calls), 'beside the probe, the same agents with the same prompts as off')
    const line = 'Unit mode skipped, change too small to slice: 7 files — the review ran in the normal mode.'
    assert.ok(on.report.includes(`⚠️ ${line}`), 'the report says why the mode did not run')
    const rec = filedRecord(on)
    assert.deepEqual(rec.unitNotices, [line])
    assert.deepEqual(rec.unitCoordinator, [], 'no profile ran the mode')
    assert.ok(!rec.dimensions.some((/** @type {{ dimension: string }} */ d) => /contract|seam/.test(d.dimension)), 'no contract or seam row')
    assert.doesNotMatch(rec.verdict, /INCOMPLETE/)
  }
})

test('unitScope on one crate with unitBatches=false: one unit slice is no slicing, the normal review and one warning line', async () => {
  const rust = [...files('crates/a/src', 'rs', 14), 'Cargo.lock']
  const on = await runEngine('review', { args: { unitScope: true, unitBatches: false }, script: script(rust, { units: { roots: ['crates/a'], packages: [], numstat: [] } }) })
  const off = await runEngine('review', { args: {}, script: script(rust) })
  assert.deepEqual(dispatch(on.calls, /^units:/), dispatch(off.calls))
  assert.deepEqual(filedRecord(on).unitNotices, ['Unit mode skipped, change too small to slice: one crate (crates/a) — the review ran in the normal mode.'])
})

// A dead or malformed probe is not "no unit in the change": the notice says the probe failed, and the run
// names it as a hole in what it could see.
test('unitScope on Rust with a dead or malformed probe: the normal review, the notice names the failed probe, notRun carries it', async () => {
  const rust = [...files('src', 'rs', 8), ...files('src/net', 'rs', 6), 'Cargo.lock']
  const off = await runEngine('review', { args: {}, script: script(rust) })
  for (const [units, why] of [[null, 'returned no result'], [{ notes: 'no idea' }, 'answered off-schema (no roots and no packages)']]) {
    const on = await runEngine('review', { args: { unitScope: true }, script: script(rust, { units }) })
    // The checkpoints differ by the probe's notRun line only, which the record assertion below pins.
    assert.deepEqual(dispatch(on.calls, /^(retry:)?units:|checkpoint/), dispatch(off.calls, /checkpoint/), 'the same agents as off')
    const line = `Unit mode skipped, the crate probe failed on the Rust change (${why}) — the review ran in the normal mode.`
    assert.ok(on.report.includes(`⚠️ ${line}`), `the report names the failed probe: ${why}`)
    assert.ok(!on.report.includes('found no crate'), 'not read as a change with no units')
    const rec = filedRecord(on)
    assert.deepEqual(rec.unitNotices, [line])
    assert.ok(rec.notRun.some((/** @type {string} */ n) => n === `rust unit probe (unitScope) — ${why}; the review ran in the normal mode`), 'a hole in coverage')
  }
})
