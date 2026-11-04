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

const CAND = { system: 'app', repo: '', repoGuessed: false, versionFrom: 'k8s/d.yaml', versionMatch: 'image: x:(\\S+)', version: 'v1', scope: 'k8s' }

test('a touched manifest buys the discovery even with no record; its candidates reach the section, once a run', async () => {
  /** @type {any[]} */ const calls = []
  /** @type {string[]} */ const logs = []
  const kit = makeExternalSources({ ragent: async (p, o) => { calls.push({ p, o }); return { candidates: [CAND, { ...CAND, system: 'stray', versionFrom: 'x.yaml' }] } }, plugin: PLUGIN, logLine: l => logs.push(l) })
  kit.touch(['src/a.rs', 'k8s/d.yaml'])
  await Promise.all([kit.prepare(['safety']), kit.prepare(['compat'])])
  assert.equal(calls.length, 1)
  assert.match(calls[0].p, /discover --repo-root "\$\(git rev-parse --show-toplevel\)" --paths [A-Za-z0-9_-]+;/)
  assert.doesNotMatch(calls[0].p, /CRAFT_SOURCE"? prepare/)
  assert.match(kit.section([]), /^\n\n## External sources\n- candidate: app — repo unknown · versionFrom `k8s\/d\.yaml` · .* craft:memory discover-externals\n$/)
  assert.deepEqual(logs, ['External candidates: 1 from 1 touched manifest(s)'])
  assert.equal(kit.lensBlock('compat'), '', 'a discovery prepares no source')
})

test('a prep and a discovery due together share one agent; a prep due later on another profile runs alone', async () => {
  /** @type {string[]} */ const prompts = []
  const kit = makeExternalSources({ ragent: async p => { prompts.push(p); return { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }], candidates: [] } }, plugin: PLUGIN, logLine: () => {} })
  kit.setRecords([OVN])
  kit.touch(['k8s/d.yaml'])
  await kit.prepare(['compat'])
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0]?.includes('prepare --repo-root') && prompts[0].includes('discover --repo-root'))
  const later = makeExternalSources({ ragent: async p => { prompts.push(p); return { systems: [], candidates: [] } }, plugin: PLUGIN, logLine: () => {} })
  later.setRecords([OVN])
  later.touch(['k8s/d.yaml'])
  await later.prepare(['safety'])
  await later.prepare(['compat'])
  assert.deepEqual(prompts.slice(1).map(p => [p.includes('prepare --repo-root'), p.includes('discover --repo-root')]), [[false, true], [true, false]])
})

test('a run whose nested run discovered discovers nothing itself; a skipped or failed discovery names the manifests', async () => {
  let n = 0
  const kit = makeExternalSources({ ragent: async () => { n++; return {} }, plugin: PLUGIN, logLine: () => {} })
  kit.touch(['k8s/d.yaml', 'flake.lock'])
  kit.untouch(['k8s/d.yaml', 'flake.lock'])
  await kit.prepare(['compat'])
  assert.equal(n, 0)
  /** @type {string[]} */ const asked = []
  const part = makeExternalSources({ ragent: async p => { asked.push(p); return { candidates: [] } }, plugin: PLUGIN, logLine: () => {} })
  part.touch(['k8s/d.yaml', 'flake.lock'])
  part.untouch(null)
  part.untouch(['k8s/d.yaml'])
  await part.prepare([])
  assert.equal(asked.length, 1, 'a manifest the nested run did not account for is read here')
  assert.deepEqual(part.discovered(), ['flake.lock'])
  const skipped = makeExternalSources({ ragent: async () => ({}), plugin: PLUGIN, logLine: () => {} })
  skipped.touch(['k8s/d.yaml', 'flake.lock'])
  skipped.skip(['safety'], 'budget below the floor')
  assert.match(skipped.section([]), /- ⚠️ deployment manifest\(s\) k8s\/d\.yaml, flake\.lock not read for external systems — budget below the floor\n/)
  const failed = makeExternalSources({ ragent: async () => { throw new Error('limit') }, plugin: PLUGIN, logLine: () => {} })
  failed.touch(['k8s/d.yaml'])
  await failed.prepare([])
  assert.match(failed.section([]), /k8s\/d\.yaml not read for external systems — the source agent did not run: limit/)
})

test('a manifest only a record scoped elsewhere reads its version from yields no candidate: the filter sees every active record', async () => {
  // The scope-matched recall finds nothing for a diff that only bumps the chart's values; the store still holds kube-ovn,
  // scoped to src/ovn, reading its version from that file.
  const values = 'charts/x/values.yaml'
  const ovn = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: values }
  const found = { ...CAND, system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: values, scope: 'charts/x' }
  /** @param {unknown} known */
  const run = async known => {
    const kit = makeExternalSources({ ragent: async () => ({ candidates: [found] }), plugin: PLUGIN, logLine: () => {} })
    kit.setRecords([])
    kit.setKnown(known)
    kit.touch([values])
    await kit.prepare(['safety'])
    return kit.section([])
  }
  assert.match(await run([]), /- candidate: kube-ovn /, 'no record known anywhere: the candidate is printed')
  assert.equal(await run([{ ...ovn, scope: 'src/ovn' }]), '', 'recorded under another scope: no candidate line')
  assert.equal(await run([{ system: 'kube-ovn', versionFrom: values }]), '', 'the same system and versionFrom, no repo: covered')
  assert.match(await run(['x', null, [ovn]]), /- candidate: kube-ovn /, 'malformed entries cover nothing')
})

test('the discovery alone for an inert diff: the recalled records filter it, no prep runs; no manifest, no agent and no section', async () => {
  /** @type {string[]} */ const prompts = []
  const found = { ...CAND, system: 'disko', versionFrom: 'flake.lock', versionMatch: '"rev": "([0-9a-f]+)"', version: 'abc123', scope: '.' }
  const kit = makeExternalSources({ ragent: async p => { prompts.push(p); return { candidates: [found, { ...found, system: 'kube-ovn' }] } }, plugin: PLUGIN, logLine: () => {} })
  kit.setRecords([OVN])
  let recalls = 0
  const section = await kit.inert(['flake.lock', 'README.md'], async () => { recalls++; return { externals: [], knownExternals: [{ system: 'kube-ovn', repo: '', versionFrom: 'flake.lock' }] } })
  assert.equal(recalls, 1)
  assert.equal(prompts.length, 1)
  assert.ok(!prompts[0]?.includes('prepare --repo-root'), 'no source prep, though a record is held')
  assert.match(section, /^\n\n## External sources\n- candidate: disko — /)
  assert.doesNotMatch(section, /kube-ovn/)
  assert.deepEqual(kit.discovered(), ['flake.lock'])
  const none = makeExternalSources({ ragent: async () => { throw new Error('never') }, plugin: PLUGIN, logLine: () => {} })
  assert.equal(await none.inert(['README.md'], async () => { throw new Error('never') }), '')
  assert.deepEqual(none.discovered(), [])
  const floor = makeExternalSources({ ragent: async () => { throw new Error('never') }, plugin: PLUGIN, logLine: () => {} })
  assert.match(await floor.inert(['flake.lock'], null, 'budget below the floor'), /flake\.lock not read for external systems — budget below the floor/)
})
