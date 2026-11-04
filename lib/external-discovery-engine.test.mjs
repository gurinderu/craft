// The discovery of external systems through the real engines (realm @nick/craft, node #435; lib/engine-harness.mjs):
// a diff that touches a deployment manifest buys the discover command in the external-sources agent, even with no
// record, and the report prints each candidate no record covers (node #434) for the human to confirm (#436); below
// the budget floor nothing runs and the report says so; a review leaves the files of its nested run to that run.
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
  const run = await review({}, { verdict: 'Approve', confirmed: [], suspected: [], notRun: [], externalSources: `## External sources\n${LINE}` }, ['src/lib.rs', MANIFEST])
  assert.equal(calls(run, /^workflow$/).length, 1)
  assert.equal(calls(run, /^external-sources$/).length, 0)
  assert.ok(run.report.includes(`### External sources\n${LINE}\n`))
  assert.equal(run.report.split(LINE).length, 2, 'once, under the nested part')
})
