// The harm cap held in code (realm @nick/craft, node #379): unit, the level table against severity.md,
// and executed — a Confirmed High naming only an operator recovery is counted, reported and recorded
// as Medium.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runEngine, filedRecord } from './engine-harness.mjs'
import { capByHarm, applyHarmCap, HARM_CAP_MARK } from './harm-cap.mjs'
import { HARM_LEVELS, HARM_CEILING } from './harm-levels.mjs'
import { raisePathFloor } from './path-severity-floor.mjs'

test('capByHarm: lowers a severity above its level\'s ceiling, and says so', () => {
  const f = { severity: 'High', why: 'w', harmLevel: 'operator-recovery', source: 'reconciler' }
  const g = capByHarm(f)
  assert.equal(g.severity, 'Medium')
  assert.equal(g.why, `w (lowered to Medium from High: ${HARM_CAP_MARK} — harm level operator-recovery allows at most Medium)`)
  assert.equal(capByHarm({ ...f, severity: 'Critical', harmLevel: 'text' }).severity, 'Low')
  assert.equal(capByHarm({ ...f, severity: 'Medium', harmLevel: 'none' }).severity, 'Low')
  assert.equal(capByHarm({ ...f, severity: 'Medium', harmLevel: 'self-healing' }).severity, 'Low')
})

test('capByHarm: leaves a finding at or under its ceiling, with no or an unknown level, and an exempt one', () => {
  for (const f of [
    { severity: 'Critical', why: 'w', harmLevel: 'data-loss' },
    { severity: 'High', why: 'w', harmLevel: 'security' },
    { severity: 'Medium', why: 'w', harmLevel: 'operator-recovery' },
    { severity: 'Low', why: 'w', harmLevel: 'operator-recovery' },
    { severity: 'Info', why: 'w', harmLevel: 'none' },
    { severity: 'High', why: 'w' },
    { severity: 'High', why: 'w', harmLevel: 'made-up' },
    { severity: 'Shouty', why: 'w', harmLevel: 'none' },
  ]) assert.equal(capByHarm(f), f, JSON.stringify(f))
  const strictMnt = { severity: 'Medium', why: 'w', harmLevel: 'none', source: 'maintainability' }
  assert.equal(capByHarm(strictMnt, f => f.source === 'maintainability'), strictMnt, 'strict mode keeps maintainability escalated')
})

test('capByHarm: a lint seed that names no harm reads as none; one that names a harm keeps its own level', () => {
  for (const source of ['clippy-pedantic', 'statix', 'deadnix']) {
    assert.equal(capByHarm({ severity: 'Medium', why: 'w', source }).severity, 'Low', source)
  }
  const named = { severity: 'Medium', why: 'w', source: 'clippy-pedantic', harm: 'h', harmLevel: 'operator-recovery' }
  assert.equal(capByHarm(named), named)
  const semgrep = { severity: 'High', why: 'w', source: 'semgrep' }
  assert.equal(capByHarm(semgrep), semgrep, 'a non-lint seed with no level is left as it is')
})

test('applyHarmCap: counts what it lowered', () => {
  const r = applyHarmCap([{ severity: 'High', harmLevel: 'operator-recovery' }, { severity: 'High', harmLevel: 'outage' }, { severity: 'Low', harmLevel: 'text' }, { severity: 'High', harmLevel: 'text' }])
  assert.deepEqual(r.findings.map(f => f.severity), ['Medium', 'High', 'Low', 'Low'])
  assert.equal(r.lowered, 2)
})

test('the path floor then the cap never fight: a floored finding keeps Medium', () => {
  for (const harmLevel of ['data-loss', 'security', 'outage', 'irreversible', 'operator-recovery']) {
    const floored = raisePathFloor({ severity: 'Low', source: 'reconciler', why: 'w', deletionOrRecoveryPath: true, harmLevel })
    assert.equal(capByHarm(floored).severity, 'Medium', harmLevel)
  }
})

test('the harm levels are severity.md\'s table, row for row, with its ceilings', () => {
  const md = readFileSync(new URL('../skills/review-rules/severity.md', import.meta.url), 'utf8')
  const rows = [...md.matchAll(/^\| `([a-z-]+)` \| [^|]+ \| (must-fix|should-fix|optional) \|$/gm)]
  assert.deepEqual(rows.map(m => m[1]), HARM_LEVELS)
  const tier = { 'must-fix': 'Critical', 'should-fix': 'Medium', optional: 'Low' }
  for (const m of rows) assert.equal(HARM_CEILING[/** @type {string} */ (m[1])], tier[/** @type {'must-fix'} */ (m[2])], m[1])
})

const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, reason: 'ok' }

/** @param {Record<string, unknown>} over */
function scriptFor(over) {
  const finding = { severity: 'High', title: 'status wedged after a failed patch', file: 'src/controller.rs', line: 3, why: 'w', fix: 'f', blastRadius: '', source: '', ruleId: '', whereChecked: '', harm: 'the object stays Pending until an operator deletes the lease by hand', ...over }
  return {
    detect: { baseRef: 'main', files: ['src/controller.rs'], spec: '', branch: 'feat/x', head: 'abc1234' },
    'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    scout: { sizeBucket: 'small', lenses: ['reconciler'], isLibrary: false, securitySensitive: false, intent: 'controller change', churn: [], notes: 'x' },
    gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
    lens: (/** @type {{ opts: { label: string } }} */ { opts }) => ({
      lens: 'reconciler',
      findings: String(opts.label).startsWith('lens:rust:reconciler') && !/resurrect/.test(opts.label) ? [finding] : [],
    }),
    dedup: { groups: [] },
    verify: UPHELD,
    'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
    synthesis: null,
    '*': null,
  }
}

/** @param {any} rec */
const rowOf = rec => (rec.ledger || []).find((/** @type {any} */ r) => r.file === 'src/controller.rs')

test('review: a Confirmed High naming operator recovery is counted, recorded and reported as Medium', async () => {
  const run = await runEngine('review', { args: {}, script: scriptFor({ harmLevel: 'operator-recovery' }) })
  const authVote = run.calls.find(c => /^verify:.*#auth$/.test(String(c.label)))
  assert.ok(authVote, 'verified as the High it was filed at: the cap comes after verification')
  const rec = filedRecord(run)
  const row = rowOf(rec)
  assert.ok(row, `the finding must reach the ledger: ${JSON.stringify(rec.ledger)}`)
  assert.equal(row.tier, 'confirmed')
  assert.equal(row.severity, 'Medium')
  assert.match(row.why, /lowered to Medium from High: harm cap/)
  assert.match(String(rec.verdict), /Warning/, `the verdict counts it as Medium, not High: ${rec.verdict}`)
  assert.deepEqual(rec.harmCap, { lowered: 1 })
  assert.deepEqual(rec.findings?.bySeverity, { Critical: 0, High: 0, Medium: 1, Low: 0, Info: 0 })
  assert.match(run.report, /⚠️ Warning/, 'the report\'s verdict line agrees')
})

test('review: the same High naming an outage stays High and blocks; with no level it is left as filed', async () => {
  for (const over of [{ harmLevel: 'outage' }, {}]) {
    const rec = filedRecord(await runEngine('review', { args: {}, script: scriptFor(over) }))
    assert.equal(rowOf(rec)?.severity, 'High', JSON.stringify(over))
    assert.match(String(rec.verdict), /Block/, JSON.stringify(over))
    assert.deepEqual(rec.harmCap, { lowered: 0 })
  }
})

test('review: a Medium pedantic gate seed that names no harm is capped at Low and cannot warn', async () => {
  const seed = { severity: 'Medium', title: 'this could be a `const fn`', file: 'src/controller.rs', line: 3, why: 'w', fix: 'f', blastRadius: '', source: 'clippy-pedantic', ruleId: '', whereChecked: '' }
  const script = scriptFor({})
  const run = await runEngine('review', { args: {}, script: { ...script, gate: { ...script.gate, seedFindings: [seed] }, lens: () => ({ lens: 'reconciler', findings: [] }) } })
  const rec = filedRecord(run)
  assert.equal(rowOf(rec)?.severity, 'Low')
  assert.deepEqual(rec.harmCap, { lowered: 1 })
  assert.doesNotMatch(String(rec.verdict), /Warning|Block/, `a lint seed with no harm leaves the verdict alone: ${rec.verdict}`)
})
