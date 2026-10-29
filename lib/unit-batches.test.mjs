// lib/unit-batches.mjs, lib/unit-graph.mjs and lib/unit-cost.mjs: the probe's lines parsed, the
// touched units packed into batches under a volume batchBudget, and the plan's cost estimate.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { batchByUnit } from './unit-batches.mjs'
import { parsePackageLines, parseNumstat, unitEdges, depSigLines } from './unit-graph.mjs'
import { costModelOf, estimatePlan } from './unit-cost.mjs'
import { RUST_UNITS } from './rust-units.mjs'

/** @param {string} dir @param {number} n @param {string} [sub] */
const rs = (dir, n, sub = 'src') => Array.from({ length: n }, (_v, i) => `${dir}/${sub}/f${i}.rs`)
/** @param {string[]} files @param {number} each */
const numstatOf = (files, each) => new Map(files.map(f => [f, each]))
const owns = (/** @type {string} */ f) => f.endsWith('.rs')

test('parsePackageLines reads the probe line per unit, deps by the profile\'s name key (Cargo\'s for Rust), first line per root', () => {
  const ps = parsePackageLines(['@@ crates/b 120 7 b-core a_util serde', '@@ ./crates/a/ 40 3 a-util', '@@ crates/b 1 1 other', 'noise', '@@ short 1'], RUST_UNITS.nameKey)
  assert.deepEqual(ps, [
    { root: 'crates/a', name: 'a_util', codeLines: 40, sigLines: 3, deps: [] },
    { root: 'crates/b', name: 'b_core', codeLines: 120, sigLines: 7, deps: ['a_util', 'serde'] },
  ])
  assert.deepEqual(parsePackageLines(null), [])
})

test('parseNumstat sums added and deleted lines, a binary file is 0', () => {
  const m = parseNumstat(['10\t5\tcrates/a/src/x.rs', '-\t-\tlogo.png', 'garbage'])
  assert.deepEqual([...m.entries()], [['crates/a/src/x.rs', 15], ['logo.png', 0]])
})

test('unitEdges are undirected among the given roots only; depSigLines counts deps outside the batch once', () => {
  const ps = parsePackageLines(['@@ crates/a 10 4 a', '@@ crates/b 10 6 b a', '@@ crates/c 10 9 c a b', '@@ crates/d 10 50 d'])
  assert.deepEqual([...unitEdges(['crates/a', 'crates/b'], ps).entries()], [['crates/a', ['crates/b']], ['crates/b', ['crates/a']]])
  assert.equal(depSigLines(['crates/c'], ps), 10)
  assert.equal(depSigLines(['crates/b', 'crates/c'], ps), 4, 'b is inside the batch')
})

test('a connected pair goes together, unconnected small units are packed by volume', () => {
  const files = [...rs('crates/a', 4), ...rs('crates/b', 4), ...rs('crates/x', 3), ...rs('crates/y', 3), ...rs('crates/z', 3), 'Cargo.lock']
  const packages = parsePackageLines(['@@ crates/a 100 0 a', '@@ crates/b 100 0 b a', '@@ crates/x 10 0 x', '@@ crates/y 10 0 y', '@@ crates/z 10 0 z'])
  const roots = packages.map(p => p.root)
  const bs = batchByUnit(files, roots, { packages, numstat: numstatOf(files, 10), batchBudget: 80, owns })
  assert.deepEqual(bs.map(b => [b.key, b.units, b.volume]), [
    ['unit:crates/a unit:crates/b', ['crates/a', 'crates/b'], 80],
    ['unit:crates/x unit:crates/y', ['crates/x', 'crates/y'], 60],
    ['unit:crates/z', ['crates/z'], 30],
  ])
  for (const b of bs) assert.ok(b.files.includes('Cargo.lock'), 'shared files ride on every batch')
  assert.deepEqual(batchByUnit([...files].reverse(), [...roots].reverse(), { packages, numstat: numstatOf(files, 10), batchBudget: 80, owns }).map(b => b.key), bs.map(b => b.key), 'deterministic')
})

test('a component over the batchBudget is split along its edges; a unit over the batchBudget alone splits by module', () => {
  const chain = [...rs('crates/a', 3), ...rs('crates/b', 3), ...rs('crates/c', 3)]
  const packages = parsePackageLines(['@@ crates/a 1 0 a', '@@ crates/b 1 0 b a', '@@ crates/c 1 0 c b', '@@ crates/big 9000 0 big'])
  const big = [...rs('crates/big', 4, 'src/net'), ...rs('crates/big', 4, 'src/db'), ...rs('crates/big', 2, 'tests')]
  const files = [...chain, ...big]
  const bs = batchByUnit(files, packages.map(p => p.root), { packages, numstat: numstatOf(files, 10), batchBudget: 60, owns })
  assert.deepEqual(bs.map(b => b.key), [
    'unit:crates/a unit:crates/b',
    'unit:crates/big//src/db+tests',
    'unit:crates/big//src/net',
    'unit:crates/c',
  ])
  assert.ok(bs.every(b => (b.volume ?? 0) <= 60))
  assert.deepEqual(batchByUnit(rs('crates/a', 3), ['crates/a'], { packages, numstat: new Map(), batchBudget: 60, owns }), [], 'too few files: no slicing')
})

test('costModelOf takes each valid number over the fitted model, a new lens on the pooled cost', () => {
  const m = costModelOf({ agentFixed: 7, unit: { perFile: 'x', perSigLine: 3 }, lenses: { tests: { rate: 2 }, custom: { fixed: 5 } }, pooled: { rate: -1 } })
  assert.equal(m.agentFixed, 7)
  assert.equal(m.unit.perSigLine, 3)
  assert.equal(m.unit.perFile, costModelOf(null).unit.perFile, 'not a number: the fitted value')
  assert.deepEqual(m.lenses['tests'], { fixed: costModelOf(null).lenses['tests']?.fixed, rate: 2 })
  assert.deepEqual(m.lenses['custom'], { fixed: 5, rate: costModelOf(null).pooled.rate })
  assert.equal(m.pooled.rate, costModelOf(null).pooled.rate, 'negative: the fitted value')
  assert.ok(costModelOf(null).agentFixed > 0 && Object.keys(costModelOf(null).lenses).includes('safety'))
})

test('estimatePlan: agentFixed once per agent, each lens its fixed part and rate on the batch units\' summed diff cost, plus contracts', () => {
  const packages = parsePackageLines(['@@ crates/a 1000 5 a', '@@ crates/b 500 8 b a'])
  const batches = [{ key: 'unit:crates/a unit:crates/b', files: ['crates/a/src/x.rs', 'crates/b/src/y.rs', 'Cargo.lock'], unit: 'crates/a', units: ['crates/a', 'crates/b'] }]
  const model = { agentFixed: 100, unit: { perChangedLine: 1, perFile: 10, perCodeLine: 0, perSigLine: 2 }, lenses: { tests: { fixed: 50, rate: 2 } }, pooled: { fixed: 20, rate: 1 } }
  const e = estimatePlan({ batches, lensGroups: [['tests'], ['safety', 'errors']], units: ['crates/a', 'crates/b'], changedOf: () => ({ lines: 20, files: 1 }), linesOf: () => 20, packages, model })
  // diff cost of the batch: 40 lines + 10·2 files + 2·(0 + 5) signature lines (b depends on a) = 70
  // tests: 100 + 50 + 2·70 = 290; a two-lens group safety+errors (pooled), priced as one agent: 100 + 2·(20 + 70) = 280;
  // contract a: 100 + 20 + (20 + 10 + 2·5) = 160; contract b: 100 + 20 + (20 + 10 + 2·8) = 166
  assert.deepEqual(e.perAgent.map(x => x.estimate), [290, 280, 160, 166])
  assert.equal(e.total, 896)
  assert.equal(e.heaviest, 290, 'the heaviest batch agent; contract agents are the same in every partition')
  assert.deepEqual(e.perAgent[0], { batch: batches[0]?.key, lenses: ['tests'], changedLines: 40, files: 2, codeLines: 1500, sigLines: 5, estimate: 290 })
})

test('parseNumstat parts the fields by any whitespace run; the path is the rest of the line, spaces kept', () => {
  const m = parseNumstat(['10 5 crates/a/src/x.rs', '3  \t 4\tdocs/a file with spaces.md', ' 2\t1\tcrates/b/y.rs\r', '- - logo one.png', '7 crates/c/z.rs'])
  assert.deepEqual([...m.entries()], [['crates/a/src/x.rs', 15], ['docs/a file with spaces.md', 7], ['crates/b/y.rs', 3], ['logo one.png', 0]])
})
