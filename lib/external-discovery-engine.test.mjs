// The discovery of external systems through the real engines (realm @nick/craft, node #435; lib/engine-harness.mjs):
// a diff that touches a deployment manifest buys the discover command in the external-sources agent, even with no
// record, and the report prints each candidate no record covers (node #434) for the human to confirm (#436); below
// the budget floor nothing runs and the report says so; a review whose nested run ran leaves the discovery to it —
// the nested run discovers over every changed path, so each manifest yields its candidate once.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const MANIFEST = 'k8s/d.yaml'
const CAND = { system: 'app', repo: 'https://github.com/acme/app', repoGuessed: true, versionFrom: MANIFEST, versionMatch: 'image: ghcr\\.io/acme/app:(\\S+)', version: 'v1.2.0', scope: 'k8s', note: 'repo guessed from the image ghcr.io/acme/app' }
const LINE = '- candidate: app — repo https://github.com/acme/app (guessed) · versionFrom `k8s/d.yaml` · versionMatch `image: ghcr\\.io/acme/app:(\\S+)` · scope `k8s` · reads v1.2.0 (repo guessed from the image ghcr.io/acme/app) — record it with craft:memory record-external, or confirm with craft:memory discover-externals'
/** @param {any} run @param {RegExp} label @returns {Array<{ label: string, prompt: string }>} */
const calls = (run, label) => run.calls.filter((/** @type {{ label: string }} */ c) => label.test(c.label))

/** @param {{ budgetTotal?: number, files?: string[] }} [o] */
const adversarial = ({ budgetTotal, files = ['src/a.go', MANIFEST] } = {}) => runEngine('adversarial-review', { args: {}, ...(budgetTotal ? { budgetTotal } : {}), script: {
  scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: files, notes: 'x' },
  'index-warmup': { indexed: false, notes: 'x' },
  review: { findings: [] },
  'coverage-critic': { findings: [] },
  'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
  'external-sources': { candidates: [CAND] },
  '*': null,
} })

test('adversarial-review: a touched manifest buys the discover command with no record, and the result prints the candidate', async () => {
  const run = await adversarial()
  const [prep, ...more] = calls(run, /^external-sources$/)
  assert.equal(more.length, 0)
  assert.match(String(prep?.prompt), /node "\$CRAFT_EXTERNALS" discover --repo-root "\$\(git rev-parse --show-toplevel\)" --paths [A-Za-z0-9_-]+;/)
  assert.equal(run.reportValue.externalSources, `## External sources\n${LINE}`)
  const none = await adversarial({ files: ['src/a.go'] })
  assert.equal(calls(none, /^external-sources$/).length, 0, 'no manifest touched, no agent')
})

test('adversarial-review: below the budget floor the discovery is skipped and named', async () => {
  const run = await adversarial({ budgetTotal: 40_000 })
  assert.equal(calls(run, /^external-sources$/).length, 0)
  assert.match(run.reportValue.externalSources, /- ⚠️ deployment manifest\(s\) k8s\/d\.yaml not read for external systems — budget below the floor/)
})

/** @param {object} args @param {unknown} nested @param {string[]} files */
const review = (args, nested, files) => runEngine('review', { args, script: {
  detect: { baseRef: 'main', files, spec: '', branch: 'feat/x', head: 'abc9999' },
  'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
  checkpoint: { runDir: '/store/.partial/run-A', error: '' },
  'log-run': { ok: true, output: ['wrote r.json'] },
  scout: { sizeBucket: 'small', lenses: ['safety'], isLibrary: false, securitySensitive: false, intent: '', churn: [], notes: 'x' },
  gate: { status: 'pass', provenance: 'CI', failedChecks: [], carriedChecks: [], seedFindings: [], notes: '' },
  lens: { lens: 'x', findings: [] },
  dedup: { groups: [] },
  'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
  'external-sources': { candidates: [CAND] },
  workflow: nested,
  '*': null,
} })

test('review: a manifest the review itself keeps (nesting barred by a language pin) is discovered here and its candidate printed', async () => {
  const run = await review({ languages: ['rust'] }, null, ['src/lib.rs', MANIFEST])
  const prep = calls(run, /^external-sources$/)
  assert.equal(prep.length, 1)
  assert.ok(String(prep[0]?.prompt).includes('discover --repo-root'))
  assert.ok(run.report.includes(`\n## External sources\n${LINE}\n`))
})

test('review: the manifests a nested run reviewed are its to discover — the review sends no discover of them and keeps its candidate line', async () => {
  const run = await review({}, { verdict: 'Approve', confirmed: [], suspected: [], notRun: [], externalSources: `## External sources\n${LINE}`, externalManifests: [MANIFEST] }, ['src/lib.rs', MANIFEST])
  assert.equal(calls(run, /^workflow$/).length, 1)
  assert.equal(calls(run, /^external-sources$/).length, 0)
  assert.ok(run.report.includes(`### External sources\n${LINE}\n`))
  assert.equal(run.report.split(LINE).length, 2, 'once, under the nested part')
})

// A manifest under generated/ is inert to the review, so an all-generated diff takes the nothing-to-review exit.
const GEN = 'deploy/generated/app.yaml'
const GENC = { ...CAND, system: 'redis', repo: 'https://github.com/redis/redis', repoGuessed: false, versionFrom: GEN, versionMatch: 'image: redis:(\\S+)', version: '7.2', scope: 'deploy/generated', note: '' }
const GEN_LINE = /- candidate: redis — repo https:\/\/github\.com\/redis\/redis · versionFrom `deploy\/generated\/app\.yaml`/g

test('review: a mixed diff (Rust, Go, a manifest) discovers the manifest once — in the nested run, never again in the review', async () => {
  const mixed = ['src/lib.rs', 'cmd/main.go', GEN]
  // The nested adversarial run, as review launches it: confined to the Go file, its scout still lists every changed path.
  const nested = await runEngine('adversarial-review', { args: { files: ['cmd/main.go'], _via: 'review' }, script: {
    scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: mixed, notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' },
    review: { findings: [] },
    'coverage-critic': { findings: [] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
    'external-sources': { candidates: [GENC] },
    '*': null,
  } })
  const [disc] = calls(nested, /^external-sources$/)
  assert.ok(String(disc?.prompt).includes('discover --repo-root'), 'the nested run discovers the manifest, outside its files')
  const section = String(nested.reportValue.externalSources)
  assert.equal(section.match(GEN_LINE)?.length, 1)
  // The review over the same diff, handed that nested answer: it sends no discover of its own and prints the line once.
  assert.deepEqual(nested.reportValue.externalManifests, [GEN], 'the nested run names the manifests its discovery read')
  const run = await review({}, { verdict: 'Approve', confirmed: [], suspected: [], notRun: [], externalSources: section, externalManifests: nested.reportValue.externalManifests }, mixed)
  assert.equal(calls(run, /^workflow$/).length, 1)
  assert.ok(!calls(run, /^external-sources$/).some(c => c.prompt.includes('discover --repo-root')), 'no second discovery in the review')
  assert.equal(run.report.match(GEN_LINE)?.length, 1, 'one candidate line in the whole report')
})

test('review: a nested run that never reached its discovery (its scout died) leaves the manifests to the review, which discovers them', async () => {
  const run = await review({}, { verdict: 'INCOMPLETE', confirmed: [], suspected: [], notRun: ['scout died'] }, ['src/lib.rs', 'cmd/main.go', MANIFEST])
  assert.equal(calls(run, /^workflow$/).length, 1)
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(String(disc[0]?.prompt).includes('discover --repo-root'), 'the review reads the manifest the nested run did not')
  assert.equal(run.report.split(LINE).length, 2, 'its candidate line, once')
})

const GEN_TEXT = '- candidate: redis — repo https://github.com/redis/redis · versionFrom `deploy/generated/app.yaml`'

// A diff of generated manifests is nothing to review, and that exit is where the discovery used to be lost. A
// flake.lock is no manifest (build tooling): pinned to rust, a `nix flake update` buys no discovery at all.
test('review pinned to rust: a generated-manifest diff is nothing to review, yet its candidate line is printed; a docs-only or flake.lock-only diff buys no agent', async () => {
  const run = await runEngine('review', { args: { languages: ['rust'] }, script: {
    detect: { baseRef: 'main', files: [GEN, 'README.md'], spec: '', branch: 'chore/gen', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [], knownExternals: [] },
    'external-sources': { candidates: [GENC] },
    '*': null,
  } })
  assert.match(run.report, /## Verdict\n✅ Approve \(NOTHING TO REVIEW\)/)
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(String(disc[0]?.prompt).includes('discover --repo-root') && !String(disc[0]?.prompt).includes('prepare --repo-root'), 'the discovery alone, no source prep')
  assert.ok(run.report.includes(`\n## External sources\n${GEN_TEXT}`))
  assert.equal(calls(run, /^lens/).length, 0, 'no lens')
  const known = await runEngine('review', { args: { languages: ['rust'] }, script: {
    detect: { baseRef: 'main', files: [GEN], spec: '', branch: 'chore/gen', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [], knownExternals: [{ system: 'redis', repo: GENC.repo, versionFrom: GEN }] },
    'external-sources': { candidates: [GENC] },
    '*': null,
  } })
  assert.ok(!known.report.includes(GEN_TEXT), 'a system already recorded is no candidate')
  const docs = await runEngine('review', { args: {}, script: {
    detect: { baseRef: 'main', files: ['README.md'], spec: '', branch: 'docs/x', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    '*': null,
  } })
  assert.match(docs.report, /✅ Approve \(NOTHING TO REVIEW\)/)
  assert.equal(calls(docs, /^(external-sources|memory-recall)$/).length, 0)
  assert.doesNotMatch(docs.report, /## External sources/)
  const flake = await runEngine('review', { args: { languages: ['rust'] }, script: {
    detect: { baseRef: 'main', files: ['flake.lock'], spec: '', branch: 'chore/flake', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    'external-sources': { candidates: [GENC] },
    '*': null,
  } })
  assert.match(flake.report, /✅ Approve \(NOTHING TO REVIEW\)/)
  assert.equal(calls(flake, /^(external-sources|memory-recall)$/).length, 0, 'a flake.lock is no deployment manifest')
  assert.doesNotMatch(flake.report, /## External sources/)
})

/** @param {string[]} files @param {{ budgetTotal?: number }} [o] */
const inertAdversarial = (files, { budgetTotal } = {}) => runEngine('adversarial-review', { args: {}, ...(budgetTotal ? { budgetTotal } : {}), script: {
  scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: files, notes: 'x' },
  'inert-crosscheck': { ok: true, files, fileCount: files.length },
  'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
  'external-sources': { candidates: [GENC] },
  '*': null,
} })

test('adversarial-review: a generated-manifest diff approves as nothing to review and still returns its candidate line; a flake.lock-only one discovers nothing', async () => {
  const run = await inertAdversarial([GEN])
  assert.equal(run.reportValue.verdict, 'Approve')
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(!String(disc[0]?.prompt).includes('prepare --repo-root'))
  assert.ok(String(run.reportValue.externalSources).startsWith(`## External sources\n${GEN_TEXT}`))
  assert.deepEqual(run.reportValue.externalManifests, [GEN])
  assert.equal(calls(run, /^review/).length, 0, 'no lens')
  const floor = await inertAdversarial([GEN], { budgetTotal: 40_000 })
  assert.equal(calls(floor, /^(external-sources|memory-recall)$/).length, 0)
  assert.match(String(floor.reportValue.externalSources), /deploy\/generated\/app\.yaml not read for external systems — budget below the floor/)
  for (const files of [['README.md'], ['flake.lock']]) {
    const none = await inertAdversarial(files)
    assert.equal(none.reportValue.verdict, 'Approve', files[0])
    assert.equal(calls(none, /^(external-sources|memory-recall)$/).length, 0, files[0])
    assert.equal(none.reportValue.externalSources, undefined, files[0])
    assert.equal(none.reportValue.externalManifests, undefined, files[0])
  }
})
