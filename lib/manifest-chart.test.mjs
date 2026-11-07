// A Helm Chart.yaml (lib/manifest-chart.mjs, realm @nick/craft, node #435).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { chartCandidates } from './manifest-chart.mjs'
import { versionPattern } from './external-source-spec.mjs'

/** What `src` reads from `text`, compiled by the validated builder discovery uses. @param {string} src @param {string} text */
const read = (src, text) => {
  const p = versionPattern(src)
  if ('error' in p) throw new Error(p.error)
  return p.re.exec(text)?.[1]
}
const CHART = 'apiVersion: v2\nname: kube-ovn\nversion: 0.1.0\nappVersion: "1.12.3"\nsources:\n  - https://github.com/kubeovn/kube-ovn\ndependencies:\n  - name: kubevirt\n    version: 1.2.0\n  - name: cert-manager\n    repository: https://charts.jetstack.io\n    version: v1.14.4\n  - name: ranged\n    version: ">=1.0"\n'

test('the application at appVersion with its source repo, and each dependency at its own version', () => {
  const got = chartCandidates(CHART.split('\n'))
  assert.deepEqual(got.map(c => [c.system, c.repo, c.version, read(c.versionMatch, CHART)]), [
    ['kube-ovn', 'https://github.com/kubeovn/kube-ovn', '1.12.3', '1.12.3'],
    ['kubevirt', '', '1.2.0', '1.2.0'],
    ['cert-manager', '', 'v1.14.4', 'v1.14.4'],
  ])
  assert.match(String(got[1]?.note), /upstream tag may differ/)
})

test('no appVersion, no application; no sources, no application either — the chart is the repo\'s own app', () => {
  assert.deepEqual(chartCandidates(['name: a', 'version: 1']), [])
  assert.deepEqual(chartCandidates(['name: a', 'appVersion: v2']), [])
  assert.deepEqual(chartCandidates(['name: a', 'appVersion: v2', 'sources: []']), [], 'an empty sources list names none')
  assert.equal(chartCandidates(['name: a', 'appVersion: v2', 'sources:', '  - git@example.com:o/a.git'])[0]?.repo, '', 'a source that is no https URL: the application, repo unknown')
  assert.deepEqual(chartCandidates(['name: a', 'appVersion: v2', 'dependencies:', '  - name: b', '    version: 1.0']).map(c => c.system), ['b'], 'its dependencies stay candidates')
})
