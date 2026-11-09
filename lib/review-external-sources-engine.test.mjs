// External sources through the real engines (realm @nick/craft, node #430, the records of node #431;
// lib/engine-harness.mjs): a recalled `external` record and a lens that reads them buy ONE prep agent, only those
// lenses and the verifiers get the directories, and the report says what was prepared and what was not; with no
// record nothing is dispatched and nothing is said. rust-audit forwards the records to its nested reviews.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const FILE = 'src/controller/subnet.rs'
const OVN = { kind: 'external', title: 'kube-ovn', system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src/controller' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'
const UPHELD = { refuted: false, citedLineMatches: true, reachable: true, premiseSupported: true, harmSupported: true, reason: 'ok' }
const FINDING = { severity: 'Medium', title: 'subnet status read before kube-ovn sets it', file: FILE, line: 12, why: 'w', fix: 'f', blastRadius: '', source: 'compat', ruleId: '', whereChecked: `${DIR}/pkg/controller/subnet.go:88`, externalSystem: 'apiserver' }

/** @param {unknown} recall @param {unknown} prep @param {string[]} [lenses] */
const review = (recall, prep, lenses = ['compat', 'safety']) => runEngine('review', { args: {}, script: {
  detect: { baseRef: 'main', files: [FILE], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses, isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: (/** @type {{ prompt: string }} */ { prompt }) => (/\*\*compat\*\*/.test(prompt) ? { lens: 'compat', findings: [FINDING] } : { lens: 'x', findings: [] }),
  dedup: { groups: [] },
  verify: () => UPHELD,
  'verify-batch': (/** @type {{ prompt: string }} */ { prompt }) => ({ verdicts: [...prompt.matchAll(/--- FINDING (\d+) ---/g)].map(m => ({ index: Number(m[1]), ...UPHELD })) }),
  'memory-recall': recall,
  'external-sources': prep,
  synthesis: null,
  '*': null,
} })
/** @param {any} run @param {RegExp} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: string }} */ c) => label.test(c.label))
/** @param {any} run @param {string} lens */
const lensPrompts = (run, lens) => calls(run, /^lens/).filter((/** @type {{ prompt: string }} */ c) => c.prompt.includes(`**${lens}**`)).map((/** @type {{ prompt: string }} */ c) => c.prompt)

test('review: a recalled external record buys one prep agent, only the external lenses and the verifiers get the block, and the report names it', async () => {
  const run = await review({ backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }] })
  const prep = calls(run, /^external-sources$/)
  assert.equal(prep.length, 1)
  assert.deepEqual([prep[0].opts.model, prep[0].opts.effort], ['haiku', 'low'])
  assert.match(prep[0].prompt, /node "\$CRAFT_SOURCE" prepare --repo-root "\$\(git rev-parse --show-toplevel\)" --spec [A-Za-z0-9_-]+;/)
  const compat = lensPrompts(run, 'compat')
  assert.ok(compat.length >= 1)
  for (const p of compat) assert.ok(p.includes(`EXTERNAL SOURCES (read-only`) && p.includes(`- kube-ovn @ v1.13.2: ${DIR}`))
  const safety = lensPrompts(run, 'safety')
  assert.ok(safety.length >= 1)
  for (const p of safety) assert.ok(!p.includes('EXTERNAL SOURCES'))
  const verifies = calls(run, /^verify/)
  assert.ok(verifies.length >= 1)
  for (const v of verifies) assert.ok(v.prompt.includes(`kube-ovn @ v1.13.2 at ${DIR}`))
  assert.match(run.report, new RegExp(`## External sources\\n- kube-ovn @ v1\\.13\\.2: \`${DIR.replace(/[.]/g, '\\.')}\`\\n- not recorded: apiserver — record it with craft:memory record-external\\n`))
  assert.match(run.report, /memory: recalled 1 external system\(s\)/)
})

test('review: a failed prep is a warning, the lenses run without the block', async () => {
  const run = await review({ backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, { systems: [{ system: 'kube-ovn', error: 'git failed: fatal: could not read from remote' }] })
  for (const p of lensPrompts(run, 'compat')) assert.ok(!p.includes('EXTERNAL SOURCES'))
  assert.match(run.report, /## External sources\n- ⚠️ kube-ovn: git failed: fatal: could not read from remote — reviewed without external context\n/)
  const dead = await review({ backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, null)
  assert.match(dead.report, /⚠️ the source cache was unreachable \(the source agent returned no answer\) — kube-ovn reviewed without external context/)
})

test('review: no external record — no prep agent and no section; a record but no external lens — no prep agent either', async () => {
  const none = await review({ backend: 'repo', why: 'w', decisions: [] }, { systems: [] })
  assert.equal(calls(none, /^external-sources$/).length, 0)
  assert.match(none.report, /## External sources\n- not recorded: apiserver/, 'a finding that names a system memory lacks is still named')
  const noLens = await review({ backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, { systems: [] }, ['safety'])
  assert.equal(calls(noLens, /^external-sources$/).length, 0)
  assert.doesNotMatch(noLens.report, /## External sources/)
})

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
// The nested CLI review has no carrier for external-system records — the binary reads the integration points from the
// reviewer's profile (`craft init`) — so the audit counts them on its own memory line and forwards none (realm
// @nick/craft, #150).
test('rust-audit: the recalled external records are counted on its memory line and not forwarded to the nested CLI reviews', async () => {
  const run = await runEngine('rust-audit', { args: {}, script: {
    scout: { baseRef: 'main', hasUnsafe: false, crates: [{ name: 'a', path: 'a' }], changedCrates: [{ name: 'a', path: 'a' }], edges: [], repoRoot: '/r', notes: 'n' },
    workflow: () => '## Verdict\n✅ Approve', synthesis: 'the audit body', 'memory-recall': { backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, '*': green,
  } })
  const nested = calls(run, /^workflow$/).filter((/** @type {any} */ c) => !c.argv[1].gateOnly)
  assert.ok(nested.length >= 1)
  for (const c of nested) assert.deepEqual([c.argv[1]._recalled, '_externals' in c.argv[1]], [true, false])
  assert.match(run.report, /memory: returned 1 external system\(s\) from repo/)
})

/** @param {unknown} nested the nested adversarial-review's answer */
const mixed = nested => runEngine('review', { args: {}, script: {
  detect: { baseRef: 'main', files: [FILE, 'web/app.js'], spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses: ['compat'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'x', findings: [] },
  dedup: { groups: [] },
  'memory-recall': { backend: 'repo', why: 'w', decisions: [], externals: [OVN] },
  'external-sources': { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }] },
  workflow: nested,
  synthesis: '## Verdict\n✅ Approve — clean.\n',
  '*': null,
} })

test('review nesting adversarial-review: the nested prep is taken, no second prep agent, and the nested sources are named under its section', async () => {
  const section = `## External sources\n- kube-ovn @ v1.13.2: \`${DIR}\`\n- not recorded: etcd — record it with craft:memory record-external`
  const run = await mixed({ verdict: 'Approve', confirmed: [], suspected: [], notRun: [], externalSources: section, externalSourcesPrepared: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, repo: OVN.repo, versionFrom: OVN.versionFrom, versionMatch: OVN.versionMatch }] })
  assert.equal(calls(run, /^workflow$/).length, 1)
  assert.equal(calls(run, /^external-sources$/).length, 0, 'the review does not prepare what the nested run prepared')
  const compat = lensPrompts(run, 'compat')
  assert.ok(compat.length >= 1)
  for (const p of compat) assert.ok(p.includes(`- kube-ovn @ v1.13.2: ${DIR}`), 'the review\'s lenses read the adopted directory')
  assert.match(run.report, /## Files outside every profile — nested adversarial-review\n[\s\S]*\n### External sources\n- not recorded: etcd — record it with craft:memory record-external\n/, 'the nested part keeps only what the review\'s own section cannot say')
  assert.match(run.report, /\n## External sources\n- kube-ovn @ v1\.13\.2: `/, 'the review\'s own section names the adopted system')
  assert.equal(run.report.split(`- kube-ovn @ v1.13.2: \`${DIR}\``).length, 2, 'once, not twice')
})

test('review nesting adversarial-review: a nested run that prepared nothing leaves the review to prepare its own', async () => {
  const run = await mixed({ verdict: 'Approve', confirmed: [], suspected: [], notRun: [] })
  assert.equal(calls(run, /^external-sources$/).length, 1)
  assert.doesNotMatch(run.report, /### External sources/)
})
