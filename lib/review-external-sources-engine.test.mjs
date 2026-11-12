// External sources through the real engines (realm @nick/craft, node #430, the records of node #431;
// lib/engine-harness.mjs): a recalled `external` record and a lens that reads them buy ONE prep agent, only those
// lenses and the verifiers get the directories, and the report says what was prepared and what was not; with no
// record nothing is dispatched and nothing is said. rust-audit forwards the records to its nested reviews.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'
const OVN = {
  kind: 'external',
  title: 'kube-ovn',
  system: 'kube-ovn',
  repo: 'https://github.com/kubeovn/kube-ovn',
  versionFrom: 'chart/values.yaml',
  versionMatch: 'tag: (\\S+)',
  scope: 'src/controller',
}
/** @param {any} run @param {RegExp} label */
const calls = (run, label) => run.calls.filter((/** @type {{ label: string }} */ c) => label.test(c.label))

const green = { verdict: 'Approve', summary: 'ok', findings: [], evidence: 'Evidence: ran it' }
// The nested CLI review has no carrier for external-system records — the binary reads the integration points from the
// reviewer's profile (`craft init`) — so the audit counts them on its own memory line and forwards none (realm
// @nick/craft, #150).
test('rust-audit: the recalled external records are counted on its memory line and not forwarded to the nested CLI reviews', async () => {
  const run = await runEngine('rust-audit', {
    args: {},
    script: {
      scout: {
        baseRef: 'main',
        hasUnsafe: false,
        crates: [{ name: 'a', path: 'a' }],
        changedCrates: [{ name: 'a', path: 'a' }],
        edges: [],
        repoRoot: '/r',
        notes: 'n',
      },
      workflow: () => '## Verdict\n✅ Approve',
      synthesis: 'the audit body',
      'memory-recall': { backend: 'repo', why: 'w', decisions: [], externals: [OVN] },
      '*': green,
    },
  })
  const nested = calls(run, /^workflow$/).filter((/** @type {any} */ c) => !c.argv[1].gateOnly)
  assert.ok(nested.length >= 1)
  for (const c of nested) assert.deepEqual([c.argv[1]._recalled, '_externals' in c.argv[1]], [true, false])
  assert.match(run.report, /memory: returned 1 external system\(s\) from repo/)
})
