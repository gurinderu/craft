// The external sources' report section (lib/external-source-text.mjs, realm @nick/craft, node #430).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { externalSourcesSection } from './external-source-text.mjs'

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
