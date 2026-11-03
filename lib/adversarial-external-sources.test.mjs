// External sources through adversarial-review (realm @nick/craft, node #430, the records of node #431;
// lib/engine-harness.mjs): a recalled `external` record and a concurrency or errors lens buy ONE prep agent, only
// those lenses and the verifiers get the directories, and the result's `externalSources` says what was prepared;
// with no record, or below the budget floor, nothing is dispatched.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runEngine } from './engine-harness.mjs'

const FILE = 'src/subnet.go'
const OVN = { kind: 'external', title: 'kube-ovn', system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'
const FINDING = { title: 'subnet status read before kube-ovn sets it', file: FILE, line: 12, severity: 'medium', description: 'd', fix: 'f', whereChecked: `${DIR}/pkg/controller/subnet.go:88`, externalSystem: 'apiserver' }
const PREPARED = { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }] }

/** @param {{ recall?: unknown, prep?: unknown, lenses?: string[], args?: object, budgetTotal?: number }} [o] */
const adversarial = ({ recall = { backend: 'repo', why: 'w', decisions: [], externals: [OVN] }, prep = PREPARED, lenses = ['correctness', 'concurrency'], args = {}, budgetTotal } = {}) =>
  runEngine('adversarial-review', { args, ...(budgetTotal ? { budgetTotal } : {}), script: {
    scout: { head: 'abc1234', baseRef: 'main', sizeBucket: 'small', lenses, changedFiles: [FILE], notes: 'x' },
    'index-warmup': { indexed: false, notes: 'x' },
    checkpoint: { runDir: '/store/.partial/run-A', error: '' },
    'review:concurrency': { findings: [FINDING] },
    review: { findings: [] },
    'coverage-critic': { findings: [] },
    'memory-recall': recall,
    'external-sources': prep,
    'log-run': { ok: true },
    '*': (/** @type {{ opts: { label?: string } }} */ { opts }) => (/^verify/.test(String(opts.label)) ? { refuted: false, premiseSupported: true, reasoning: 'ok', severity: 'medium' } : null),
  } })
/** @param {any} run @param {RegExp} label @returns {Array<{ label: string, prompt: string, opts: any }>} */
const calls = (run, label) => run.calls.filter((/** @type {{ label: string }} */ c) => label.test(c.label))

test('adversarial-review: a recalled external record and a concurrency lens buy one prep agent; only that lens and the verifiers get the block; the result names it', async () => {
  const run = await adversarial()
  const prep = calls(run, /^external-sources$/)
  assert.equal(prep.length, 1)
  assert.deepEqual([prep[0]?.opts.model, prep[0]?.opts.effort, prep[0]?.opts.phase], ['haiku', 'low', 'Prep'])
  assert.match(String(prep[0]?.prompt), /node "\$CRAFT_SOURCE" prepare --repo-root "\$\(git rev-parse --show-toplevel\)" --spec [A-Za-z0-9_-]+;/)
  const at = (/** @type {RegExp} */ re) => run.calls.findIndex((/** @type {{ label: string }} */ c) => re.test(c.label))
  assert.ok(at(/^external-sources$/) < at(/^review:/), 'the prep runs before any lens')
  const [conc] = calls(run, /^review:concurrency$/)
  assert.ok(conc?.prompt.includes('EXTERNAL SOURCES (read-only') && conc.prompt.includes(`- kube-ovn @ v1.13.2: ${DIR}`))
  const [corr] = calls(run, /^review:correctness$/)
  assert.ok(corr && !corr.prompt.includes('EXTERNAL SOURCES'), 'a lens outside the chosen set gets no block')
  const verifies = calls(run, /^verify/)
  assert.ok(verifies.length >= 1)
  for (const v of verifies) assert.ok(v.prompt.includes(`kube-ovn @ v1.13.2 at ${DIR}`))
  assert.equal(run.reportValue.externalSources, `## External sources\n- kube-ovn @ v1.13.2: \`${DIR}\`\n- not recorded: apiserver — record it with craft:memory record-external`)
})

test('adversarial-review: the errors lens reads the sources too; a failed prep is a warning and no lens gets the block', async () => {
  const run = await adversarial({ lenses: ['correctness', 'errors'], prep: { systems: [{ system: 'kube-ovn', error: 'git failed: fatal: could not read from remote' }] } })
  assert.equal(calls(run, /^external-sources$/).length, 1)
  for (const c of calls(run, /^(review|verify)/)) assert.ok(!c.prompt.includes('EXTERNAL SOURCES'))
  assert.match(run.reportValue.externalSources, /^## External sources\n- ⚠️ kube-ovn: git failed: fatal: could not read from remote — reviewed without external context$/)
})

test('adversarial-review: no external record, or no lens that reads one — no prep agent; a finding naming a system is still reported', async () => {
  const none = await adversarial({ recall: { backend: 'repo', why: 'w', decisions: [] } })
  assert.equal(calls(none, /^external-sources$/).length, 0)
  assert.equal(none.reportValue.externalSources, '## External sources\n- not recorded: apiserver — record it with craft:memory record-external')
  const noLens = await adversarial({ lenses: ['correctness', 'security'] })
  assert.equal(calls(noLens, /^external-sources$/).length, 0)
  assert.equal(noLens.reportValue.externalSources, undefined)
})

test('adversarial-review: records a launcher forwarded buy the prep above the budget floor and nothing below it', async () => {
  const args = { _recalled: true, _externals: [OVN] }
  const above = await adversarial({ args })
  assert.equal(calls(above, /^memory-recall$/).length, 0)
  assert.equal(calls(above, /^external-sources$/).length, 1)
  const below = await adversarial({ args, budgetTotal: 40_000 })
  assert.equal(calls(below, /^external-sources$/).length, 0)
  for (const c of calls(below, /^review:/)) assert.ok(!c.prompt.includes('EXTERNAL SOURCES'))
  const recalledBelow = await adversarial({ budgetTotal: 40_000 })
  assert.deepEqual([calls(recalledBelow, /^memory-recall$/).length, calls(recalledBelow, /^external-sources$/).length], [0, 0])
})
