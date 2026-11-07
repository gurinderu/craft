// The tombstone memory keyed per binding (realm @nick/craft, vimarsha #242; rule #238): toolIdentity names
// what tells two gate-tool findings of one fingerprint apart, and the carried set keeps the newest
// tombstone per fingerprint AND that identity — so two deadnix bindings of one file are both remembered,
// while a recidivist of one binding still collapses to one row.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { toolIdentity, toolDistinct } from './prior-decision-match.mjs'
import { newestTombstonePerBinding, pruneTombstones } from './ledger-shards.mjs'

/** @param {string} title @param {string} why @param {Record<string, unknown>} [over] */
const nix = (title, why, over = {}) => ({ fp: 'f1', source: 'deadnix', ruleId: 'MNT-001', title, why, ...over })

test('toolIdentity: a rule-less tool finding is its normalized title, a lint its toolRule, a lens finding nothing', () => {
  assert.equal(toolIdentity(nix('Unused lambda pattern:  SELF', '')), 'title:unused lambda pattern: self')
  assert.equal(toolIdentity({ source: 'tool', title: 'Unused let binding: x' }), 'title:unused let binding: x', 'a source-less seed')
  assert.equal(toolIdentity({ source: 'clippy', toolRule: 'clippy::Needless_Clone', title: 'a' }), 'rule:needless_clone')
  assert.equal(toolIdentity({ source: 'safety', title: 'Unused lambda pattern: self' }), '', 'a review lens is no tool')
})

test('toolIdentity agrees with toolDistinct on two rule-less findings and on two lints', () => {
  /** @type {Array<[Record<string, unknown>, Record<string, unknown>]>} */
  const pairs = [
    [nix('Unused lambda pattern: self', ''), nix('Unused lambda pattern: pkgs', '')],
    [nix('Unused lambda pattern: self', ''), nix(' unused lambda pattern: self', '')],
    [{ source: 'clippy', toolRule: 'a', title: 't' }, { source: 'clippy', toolRule: 'clippy::b', title: 't' }],
    [{ source: 'clippy', toolRule: 'a', title: 't' }, { source: 'clippy', toolRule: 'clippy::a', title: 'u' }],
  ]
  for (const [a, b] of pairs) assert.equal(toolIdentity(a) !== toolIdentity(b), toolDistinct(a, b), JSON.stringify([a, b]))
})

test('a mixed pair — a toolRule beside none, or a tool finding beside a lens finding — has distinct identities that toolDistinct does not tell apart', () => {
  const [lint, ruleless] = [{ source: 'clippy', toolRule: 'clippy::a', title: 't' }, { source: 'clippy', title: 't' }]
  assert.deepEqual([toolIdentity(lint), toolIdentity(ruleless)], ['rule:a', 'title:t'])
  assert.equal(toolDistinct(lint, ruleless), false)
  assert.equal(toolDistinct(ruleless, lint), false)
  const lens = { source: 'safety', title: 't' }
  assert.deepEqual([toolIdentity(lens), toolIdentity(ruleless)], ['', 'title:t'], 'a lens finding beside a tool finding')
  assert.equal(toolDistinct(lens, ruleless), false)
})

test('newestTombstonePerBinding keeps one row per binding of a shared fingerprint, the newest of each', () => {
  const out = newestTombstonePerBinding([
    nix('Unused lambda pattern: self', 'resolved in round 1'),
    nix('Unused lambda pattern: pkgs', 'dismissed in round 2'),
    nix('Unused lambda pattern: self', 'resolved in round 3'),
  ], toolIdentity)
  assert.deepEqual(out.map(t => [t['title'], t.why]), [
    ['Unused lambda pattern: self', 'resolved in round 3'],
    ['Unused lambda pattern: pkgs', 'dismissed in round 2'],
  ])
})

test('newestTombstonePerBinding still merges a lens finding by fingerprint alone, title or not', () => {
  const lens = (/** @type {string} */ title, /** @type {string} */ why) => ({ fp: 'f2', source: 'safety', ruleId: 'ERR-001', title, why })
  assert.deepEqual(newestTombstonePerBinding([lens('a', 'resolved in round 1'), lens('b', 'resolved in round 2')], toolIdentity).map(t => t.why), ['resolved in round 2'])
})

test('pruneTombstones caps the per-binding set by the oldest rounds, as before', () => {
  const out = pruneTombstones([
    nix('Unused lambda pattern: self', 'resolved in round 1'),
    nix('Unused lambda pattern: pkgs', 'resolved in round 3'),
    nix('Unused lambda pattern: lib', 'resolved in round 2'),
  ], { max: 2, identity: toolIdentity })
  assert.deepEqual(out.map(t => t['title']), ['Unused lambda pattern: pkgs', 'Unused lambda pattern: lib'])
})

test('pruneTombstones without an identity merges by fingerprint alone', () => {
  const out = pruneTombstones([nix('Unused lambda pattern: self', 'resolved in round 1'), nix('Unused lambda pattern: pkgs', 'resolved in round 2')])
  assert.deepEqual(out.map(t => t['title']), ['Unused lambda pattern: pkgs'])
})
