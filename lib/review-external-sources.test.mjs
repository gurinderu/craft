// The run's external-sources kit (lib/review-external-sources.mjs, realm @nick/craft, node #430): one prep agent
// a run when due, the blocks only for the engine's lenses, a nested run's prep adopted, a skipped prep named.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { EXTERNAL_LENSES, makeExternalSources } from './review-external-sources.mjs'

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const VIRT = { ...OVN, system: 'kubevirt', repo: 'https://github.com/kubevirt/kubevirt' }
const PLUGIN = { craftRoot: '/craft', version: '9.9.9', repo: '/work/op' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'

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

test('a nested run\'s prep is adopted only when it answers for every record, each directory checked again, and then no agent runs', async () => {
  /** @type {unknown[]} */ const calls = []
  const make = () => makeExternalSources({ ragent: async p => { calls.push(p); return { systems: [] } }, plugin: PLUGIN, logLine: () => {} })
  const partial = make()
  partial.setRecords([OVN, VIRT])
  const spec = (/** @type {typeof OVN} */ r) => ({ repo: r.repo, versionFrom: r.versionFrom, versionMatch: r.versionMatch })
  assert.equal(partial.adopt([{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...spec(OVN) }]), false)
  await partial.prepare(['compat'])
  assert.equal(calls.length, 1, 'kubevirt unanswered: the run prepares itself')
  const other = make()
  other.setRecords([OVN])
  for (const diff of [{ repo: 'https://github.com/fork/kube-ovn' }, { versionFrom: 'go.mod' }, { versionMatch: 'v(\\S+)' }, {}]) {
    const entry = { system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...spec(OVN), ...diff }
    assert.equal(other.adopt(Object.keys(diff).length ? [entry] : [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }]), false, `refused: ${JSON.stringify(diff)}`)
  }
  const kit = make()
  kit.setRecords([OVN, VIRT])
  assert.equal(kit.outcome(), null, 'nothing prepared yet')
  assert.equal(kit.adopt([{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...spec(OVN) }, { system: 'kubevirt', ref: 'v1', dir: '/etc', ...spec(VIRT) }]), true)
  await kit.prepare(['compat'])
  assert.equal(calls.length, 1, 'adopted: no second agent')
  assert.deepEqual(kit.outcome(), [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR, ...spec(OVN) }, { system: 'kubevirt', error: 'prep answer not trusted', ...spec(VIRT) }])
  assert.match(kit.lensBlock('compat'), /- kube-ovn @ v1\.13\.2: /)
  assert.doesNotMatch(kit.lensBlock('compat'), /\/etc/)
})

test('the lens block states the rule for an unlisted system inline, in words every engine can read', () => {
  const kit = makeExternalSources({ ragent: async () => ({ systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }] }), plugin: PLUGIN, logLine: () => {}, lenses: ['errors'] })
  kit.setRecords([OVN])
  return kit.prepare(['errors']).then(() => {
    assert.match(kit.lensBlock('errors'), /For a system not listed here, a claim about how it behaves stands only on that system's source at the deployed version, opened by you; otherwise it is an open question, not a finding\.$/)
    assert.doesNotMatch(kit.lensBlock('errors'), /catalogue|R20/)
    assert.equal(kit.lensBlock('compat'), '', 'the engine\'s own lens set decides')
  })
})

test('a prep that was due and skipped is named in the section with the systems; one that was not due says nothing', async () => {
  const kit = makeExternalSources({ ragent: async () => ({ systems: [] }), plugin: PLUGIN, logLine: () => {} })
  kit.setRecords([OVN, VIRT])
  kit.skip(['safety'], 'budget below the floor')
  assert.equal(kit.section([]), '', 'no lens would have read it')
  kit.skip(['compat'], 'budget below the floor')
  assert.equal(kit.section([]), '\n\n## External sources\n- ⚠️ kube-ovn, kubevirt reviewed without external context — budget below the floor\n')
})
