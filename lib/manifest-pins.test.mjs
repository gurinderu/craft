// flake.lock inputs and Terraform git modules (lib/manifest-pins.mjs, realm @nick/craft, node #435).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { flakeCandidates, terraformCandidates } from './manifest-pins.mjs'

/** @param {string} src @param {string} text */
const read = (src, text) => new RegExp(src, 'm').exec(text)?.[1]
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const LOCK = JSON.stringify({ nodes: {
  nixpkgs: { locked: { owner: 'NixOS', repo: 'nixpkgs', rev: 'c'.repeat(40), type: 'github' } },
  crane: { locked: { lastModified: 1, narHash: 'x', owner: 'ipetkov', repo: 'crane', rev: A, type: 'github' }, original: { owner: 'ipetkov', repo: 'crane', type: 'github' } },
  lab: { locked: { host: 'gitlab.example.com', owner: 'o', repo: 'r', rev: B, type: 'gitlab' } },
  priv: { locked: { rev: B, revCount: 3, type: 'git', url: 'ssh://git@h/p.git' } },
  path: { locked: { path: '/x', type: 'path' } },
  root: { inputs: { crane: 'crane' } },
}, root: 'root', version: 7 }, null, 2)

test('github, gitlab and git inputs at their locked commit; nixpkgs, root and a path input skipped', () => {
  const got = flakeCandidates(LOCK)
  assert.deepEqual(got.map(c => [c.system, c.repo, c.version, read(c.versionMatch, LOCK)]), [
    ['crane', 'https://github.com/ipetkov/crane', A, A],
    ['lab', 'https://gitlab.example.com/o/r', B, B],
    ['priv', '', B, B],
  ])
  assert.deepEqual(flakeCandidates('not json'), [])
})

test('a git-sourced module pinned by ref: the subdir cut from the repo, https only', () => {
  const tf = 'module "v" {\n  source = "git::https://github.com/o/vpc.git//modules/sub?ref=v5.1.0"\n}\nmodule "s" {\n  source = "git::ssh://git@github.com/o/thing.git?depth=1&ref=1.0.0"\n}\nmodule "r" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n'
  const got = terraformCandidates(tf.split('\n'))
  assert.deepEqual(got.map(c => [c.system, c.repo, c.version, read(c.versionMatch, tf)]), [
    ['vpc', 'https://github.com/o/vpc.git', 'v5.1.0', 'v5.1.0'],
    ['thing', '', '1.0.0', '1.0.0'],
  ])
})
