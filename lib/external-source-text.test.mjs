// The external sources' report section (lib/external-source-text.mjs, realm @nick/craft, node #430).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { NESTED_OWN_LINE, externalSourcesSection } from './external-source-text.mjs'
import { CANDIDATES_SHOWN } from './external-candidate.mjs'
import { unrecordedOnly } from './review-nested-report.mjs'

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const VIRT = { ...OVN, system: 'kubevirt', repo: 'https://github.com/kubevirt/kubevirt' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'

test('the section names what was prepared, warns for what was not, and names systems memory does not record', () => {
  const st = { ran: true, prepared: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }], failed: [{ system: 'kubevirt', error: 'git failed: x' }], unreachable: '' }
  assert.equal(externalSourcesSection(st, [OVN, VIRT], [{ externalSystem: 'apiserver' }, { externalSystem: 'APISERVER' }, { externalSystem: 'Kube-OVN' }, {}]), [
    '\n\n## External sources',
    `- kube-ovn @ v1.13.2: \`${DIR}\``,
    '- ⚠️ kubevirt: git failed: x — reviewed without external context',
    '- not recorded: apiserver — record it with craft:memory record-external',
    '- not recorded: APISERVER — record it with craft:memory record-external',
  ].join('\n') + '\n')
  const down = { ran: true, prepared: [], failed: [], unreachable: 'no git' }
  assert.match(externalSourcesSection(down, [OVN, VIRT], []), /⚠️ the source cache was unreachable \(no git\) — kube-ovn, kubevirt reviewed without external context/)
  assert.equal(externalSourcesSection({ ran: false, prepared: [], failed: [], unreachable: '' }, [], [{}]), '')
})

const CAND = { system: 'app', repo: '', repoGuessed: false, versionFrom: 'k8s/d.yaml', versionMatch: 'image: x:(\\S+)', version: 'v1', scope: 'k8s' }
const NONE = { ran: false, prepared: [], failed: [], unreachable: '' }

test('the discovery\'s lines: candidates up to the bound, the rest counted, manifests past the bound and an error named', () => {
  const many = Array.from({ length: CANDIDATES_SHOWN + 2 }, (_, i) => ({ ...CAND, system: `s${i}` }))
  const text = externalSourcesSection(NONE, [], [], { ran: true, candidates: many, error: '', manifests: ['k8s/d.yaml'], dropped: 3 })
  assert.equal(text.split('\n').filter(l => l.startsWith('- candidate: ')).length, CANDIDATES_SHOWN)
  assert.match(text, /- … 2 more candidate\(s\) — list them with craft:memory discover-externals\n/)
  assert.match(text, /- ⚠️ deployment manifest\(s\): 3 more touched past the bound of \d+, not read — run craft:memory discover-externals\n/)
  assert.match(externalSourcesSection(NONE, [], [], { ran: true, candidates: [], error: 'no copy', manifests: ['a.yaml'], dropped: 0 }), /- ⚠️ deployment manifest\(s\) a\.yaml not read for external systems — no copy\n/)
  assert.equal(externalSourcesSection(NONE, [], [], { ran: true, candidates: [], error: '', manifests: ['a.yaml'], dropped: 0 }), '', 'nothing found, nothing said')
})

test('a launcher that adopted a nested prep keeps the nested run\'s own lines: unrecorded systems and its discovery', () => {
  const section = externalSourcesSection({ ran: true, prepared: [{ system: 'kube-ovn', ref: 'v1', dir: '/d' }], failed: [], unreachable: '' }, [OVN], [{ externalSystem: 'etcd' }], { ran: true, candidates: [CAND], error: 'x', manifests: ['k8s/d.yaml'], dropped: 0 }).trim()
  const kept = unrecordedOnly(section).split('\n')
  assert.deepEqual(kept.map(l => l.slice(0, 22)), ['## External sources', '- not recorded: etcd —', '- candidate: app — rep', '- ⚠️ deployment manife'])
  assert.ok(section.split('\n').every(l => kept.includes(l) || !NESTED_OWN_LINE.test(l)))
})
