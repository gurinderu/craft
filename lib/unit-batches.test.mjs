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

test('costModelOf takes valid numbers over the placeholder; estimatePlan sums agents per batch and lens group, plus contracts', () => {
  const m = costModelOf({ fixed: 100, perChangedLine: 'x', perCodeLine: -1, perSigLine: 2 })
  assert.equal(m.fixed, 100)
  assert.equal(m.perSigLine, 2)
  assert.ok(m.perChangedLine > 0 && m.perCodeLine >= 0)
  const packages = parsePackageLines(['@@ crates/a 1000 5 a', '@@ crates/b 500 8 b a'])
  const batches = [{ key: 'unit:crates/a unit:crates/b', files: ['crates/a/src/x.rs', 'crates/b/src/y.rs', 'Cargo.lock'], unit: 'crates/a', units: ['crates/a', 'crates/b'] }]
  const model = { fixed: 1000, perChangedLine: 10, perCodeLine: 1, perSigLine: 2 }
  const e = estimatePlan({ batches, lensGroups: [['tests'], ['safety', 'errors']], units: ['crates/a', 'crates/b'], changedOf: () => 20, linesOf: () => 20, packages, model })
  assert.equal(e.agents, 4)
  // a batch agent: 1000 + 10·40 + 1·1500 + 2·0 = 2900; a contract agent: 1000 + 10·20 + 2·sig
  assert.deepEqual(e.perAgent.map(a => a.estimate), [2900, 2900, 1210, 1216])
  assert.equal(e.total, 2900 * 2 + 1210 + 1216)
})

test('parseNumstat parts the fields by any whitespace run; the path is the rest of the line, spaces kept', () => {
  const m = parseNumstat(['10 5 crates/a/src/x.rs', '3  \t 4\tdocs/a file with spaces.md', ' 2\t1\tcrates/b/y.rs\r', '- - logo one.png', '7 crates/c/z.rs'])
  assert.deepEqual([...m.entries()], [['crates/a/src/x.rs', 15], ['docs/a file with spaces.md', 7], ['crates/b/y.rs', 3], ['logo one.png', 0]])
})
