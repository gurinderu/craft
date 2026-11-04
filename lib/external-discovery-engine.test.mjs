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

const FLAKE = { ...CAND, system: 'disko', repo: 'https://github.com/nix-community/disko', repoGuessed: false, versionFrom: 'flake.lock', versionMatch: '"rev": "([0-9a-f]+)"', version: 'abc123', scope: '.', note: '' }
const FLAKE_LINE = /- candidate: disko — repo https:\/\/github\.com\/nix-community\/disko · versionFrom `flake\.lock`/g

test('review: a mixed diff (Rust, Go, flake.lock) discovers flake.lock once — in the nested run, never again in the review', async () => {
  const mixed = ['src/lib.rs', 'cmd/main.go', 'flake.lock']
  // The nested adversarial run, as review launches it: confined to the Go file, its scout still lists every changed path.
  const nested = await runEngine('adversarial-review', { args: { files: ['cmd/main.go'], _via: 'review' }, script: {
    scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: mixed, notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' },
    review: { findings: [] },
    'coverage-critic': { findings: [] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
    'external-sources': { candidates: [FLAKE] },
    '*': null,
  } })
  const [disc] = calls(nested, /^external-sources$/)
  assert.ok(String(disc?.prompt).includes('discover --repo-root'), 'the nested run discovers flake.lock, outside its files')
  const section = String(nested.reportValue.externalSources)
  assert.equal(section.match(FLAKE_LINE)?.length, 1)
  // The review over the same diff, handed that nested answer: it sends no discover of its own and prints the line once.
  assert.deepEqual(nested.reportValue.externalManifests, ['flake.lock'], 'the nested run names the manifests its discovery read')
  const run = await review({}, { verdict: 'Approve', confirmed: [], suspected: [], notRun: [], externalSources: section, externalManifests: nested.reportValue.externalManifests }, mixed)
  assert.equal(calls(run, /^workflow$/).length, 1)
  assert.ok(!calls(run, /^external-sources$/).some(c => c.prompt.includes('discover --repo-root')), 'no second discovery in the review')
  assert.equal(run.report.match(FLAKE_LINE)?.length, 1, 'one candidate line in the whole report')
})

test('review: a nested run that never reached its discovery (its scout died) leaves the manifests to the review, which discovers them', async () => {
  const run = await review({}, { verdict: 'INCOMPLETE', confirmed: [], suspected: [], notRun: ['scout died'] }, ['src/lib.rs', 'cmd/main.go', MANIFEST])
  assert.equal(calls(run, /^workflow$/).length, 1)
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(String(disc[0]?.prompt).includes('discover --repo-root'), 'the review reads the manifest the nested run did not')
  assert.equal(run.report.split(LINE).length, 2, 'its candidate line, once')
})

const LOCK_LINE = '- candidate: disko — repo https://github.com/nix-community/disko · versionFrom `flake.lock`'

// Unpinned, flake.lock alone wakes the nix profile, which discovers as any profile does; pinned to another language
// (rust-review) the same diff is nothing to review, and that exit is where the discovery used to be lost.
test('review pinned to rust: a flake.lock-only diff (a `nix flake update`) is nothing to review, yet its candidate line is printed; a docs-only diff buys no agent', async () => {
  const run = await runEngine('review', { args: { languages: ['rust'] }, script: {
    detect: { baseRef: 'main', files: ['flake.lock', 'README.md'], spec: '', branch: 'chore/flake', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [], knownExternals: [] },
    'external-sources': { candidates: [FLAKE] },
    '*': null,
  } })
  assert.match(run.report, /## Verdict\n✅ Approve \(NOTHING TO REVIEW\)/)
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(String(disc[0]?.prompt).includes('discover --repo-root') && !String(disc[0]?.prompt).includes('prepare --repo-root'), 'the discovery alone, no source prep')
  assert.ok(run.report.includes(`\n## External sources\n${LOCK_LINE}`))
  assert.equal(calls(run, /^lens/).length, 0, 'no lens')
  const known = await runEngine('review', { args: { languages: ['rust'] }, script: {
    detect: { baseRef: 'main', files: ['flake.lock'], spec: '', branch: 'chore/flake', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    'memory-recall': { backend: 'repo', why: 'w', decisions: [], knownExternals: [{ system: 'disko', repo: FLAKE.repo, versionFrom: 'flake.lock' }] },
    'external-sources': { candidates: [FLAKE] },
    '*': null,
  } })
  assert.ok(!known.report.includes(LOCK_LINE), 'a system already recorded is no candidate')
  const docs = await runEngine('review', { args: {}, script: {
    detect: { baseRef: 'main', files: ['README.md'], spec: '', branch: 'docs/x', head: 'abc9999' },
    'log-run': { ok: true, output: ['wrote r.json'] },
    '*': null,
  } })
  assert.match(docs.report, /✅ Approve \(NOTHING TO REVIEW\)/)
  assert.equal(calls(docs, /^(external-sources|memory-recall)$/).length, 0)
  assert.doesNotMatch(docs.report, /## External sources/)
})

/** @param {string[]} files @param {{ budgetTotal?: number }} [o] */
const inertAdversarial = (files, { budgetTotal } = {}) => runEngine('adversarial-review', { args: {}, ...(budgetTotal ? { budgetTotal } : {}), script: {
  scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: files, notes: 'x' },
  'inert-crosscheck': { ok: true, files, fileCount: files.length },
  'memory-recall': { backend: 'repo', why: 'w', decisions: [] },
  'external-sources': { candidates: [FLAKE] },
  '*': null,
} })

test('adversarial-review: a flake.lock-only diff approves as nothing to review and still returns its candidate line', async () => {
  const run = await inertAdversarial(['flake.lock'])
  assert.equal(run.reportValue.verdict, 'Approve')
  const disc = calls(run, /^external-sources$/)
  assert.equal(disc.length, 1)
  assert.ok(!String(disc[0]?.prompt).includes('prepare --repo-root'))
  assert.ok(String(run.reportValue.externalSources).startsWith(`## External sources\n${LOCK_LINE}`))
  assert.deepEqual(run.reportValue.externalManifests, ['flake.lock'])
  assert.equal(calls(run, /^review/).length, 0, 'no lens')
  const floor = await inertAdversarial(['flake.lock'], { budgetTotal: 40_000 })
  assert.equal(calls(floor, /^(external-sources|memory-recall)$/).length, 0)
  assert.match(String(floor.reportValue.externalSources), /flake\.lock not read for external systems — budget below the floor/)
  const docs = await inertAdversarial(['README.md'])
  assert.equal(calls(docs, /^(external-sources|memory-recall)$/).length, 0)
  assert.equal(docs.reportValue.externalSources, undefined)
})
