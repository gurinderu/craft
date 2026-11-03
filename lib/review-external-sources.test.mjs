// The review's external sources (lib/review-external-sources.mjs, realm @nick/craft, node #430): the prep
// prompt carries the engine's own command, the answer is read against what was asked, and the blocks and the
// report section say what the lenses had.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { EXTERNAL_LENSES, externalSourcesSection, makeExternalSources, readPrep, sourcePrepPrompt } from './review-external-sources.mjs'
import { encodeSpec } from './external-source-spec.mjs'

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const VIRT = { ...OVN, system: 'kubevirt', repo: 'https://github.com/kubevirt/kubevirt' }
const PLUGIN = { craftRoot: '/craft', version: '9.9.9', repo: '/work/op' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'

test('the prep prompt locates the shipped CLI like the logger and runs the one command the engine built', () => {
  const p = sourcePrepPrompt([OVN], PLUGIN)
  assert.ok(p.includes(`'/craft'"/lib/craft-source.mjs"`), 'the explicit craftRoot candidate')
  assert.ok(p.includes(`cd '/work/op' && node "$CRAFT_SOURCE" prepare --repo-root "$(git rev-parse --show-toplevel)" --spec ${encodeSpec([OVN])}; else`))
  assert.match(p, /return it unchanged/)
  assert.match(p, /Never clone, fetch or download anything yourself/)
})

test('the answer is read per system asked for; a stray or malformed entry prepares nothing', () => {
  const st = readPrep({ systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }, { system: 'kubevirt', error: 'git failed: x' }, { system: 'other', ref: 'v1', dir: '/x' }] }, [OVN, VIRT])
  assert.deepEqual(st, { ran: true, prepared: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }], failed: [{ system: 'kubevirt', error: 'git failed: x' }], unreachable: '' })
  assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn', ref: '-x', dir: DIR }] }, [OVN]).failed, [{ system: 'kube-ovn', error: 'no prepared directory in the answer' }])
  assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn', ref: 'v1', dir: 'rel/dir' }] }, [OVN]).prepared, [])
  assert.equal(readPrep(null, [OVN]).unreachable, 'the source agent returned no answer')
  assert.equal(readPrep({ error: 'CRAFT_SOURCE: no usable copy' }, [OVN]).unreachable, 'CRAFT_SOURCE: no usable copy')
})

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

test('the kit runs one agent a run, only with a record and a lens that reads external sources, and only those lenses get the block', async () => {
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  const kit = makeExternalSources({ ragent: async (p, o) => { calls.push({ p, o }); return { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }] } }, plugin: PLUGIN, logLine: l => logs.push(l) })
  await kit.prepare(['compat'])
  assert.equal(calls.length, 0, 'no record, no agent')
  kit.setRecords([OVN, { system: '' }])
  assert.deepEqual(logs, ['⚠️ external record #1: no system name of letters, digits, `.`, `_` or `-`'])
  await kit.prepare(['safety', 'errors'])
  assert.equal(calls.length, 0, 'no lens that reads external sources')
  await Promise.all([kit.prepare(['reconciler']), kit.prepare(['compat'])])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].o, { label: 'external-sources', phase: 'Scout', schema: calls[0].o.schema, model: 'haiku', effort: 'low' })
  for (const lens of EXTERNAL_LENSES) assert.match(kit.lensBlock(lens), new RegExp(`^EXTERNAL SOURCES[^\\n]*\\n- kube-ovn @ v1\\.13\\.2: ${DIR.replace(/[.]/g, '\\.')}\\n`))
  assert.equal(kit.lensBlock('safety'), '')
  assert.match(kit.verifyBlock(), /kube-ovn @ v1\.13\.2 at \/home\/u/)
})

test('a dispatch the budget refused leaves the cache unreachable, named', async () => {
  const kit = makeExternalSources({ ragent: async () => { throw new Error('budget exhausted') }, plugin: PLUGIN, logLine: () => {} })
  kit.setRecords([OVN])
  await kit.prepare(['compat'])
  assert.equal(kit.lensBlock('compat'), '')
  assert.match(kit.section([]), /unreachable \(the source agent did not run: budget exhausted\)/)
})
