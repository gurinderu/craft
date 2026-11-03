// The external sources' prep (lib/external-source-prep.mjs, realm @nick/craft, node #430): the prompt carries the
// engine's own command, and the answer is read against what was asked, a directory trusted only where it belongs.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readPrep, sourcePrepPrompt } from './external-source-prep.mjs'
import { encodeSpec } from './external-source-spec.mjs'

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const VIRT = { ...OVN, system: 'kubevirt', repo: 'https://github.com/kubevirt/kubevirt' }
const PLUGIN = { craftRoot: '/craft', version: '9.9.9', repo: '/work/op' }
const DIR = '/home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2'

test('the prep prompt locates the shipped CLI like the logger and runs the one command the engine built', () => {
  const p = sourcePrepPrompt([OVN], PLUGIN)
  assert.ok(p.includes(`'/craft'"/lib/craft-source.mjs"`), 'the explicit craftRoot candidate')
  assert.ok(p.includes(`cd '/work/op' && node "$CRAFT_SOURCE" prepare --repo-root "$(git rev-parse --show-toplevel)" --spec ${encodeSpec([OVN])}; else`))
  assert.match(p, /each in a Bash call of its own with the Bash tool's timeout set to 600000/)
  const two = sourcePrepPrompt([OVN, VIRT], PLUGIN)
  assert.deepEqual([...two.matchAll(/--spec ([A-Za-z0-9_-]+);/g)].map(m => m[1]), [encodeSpec([OVN]), encodeSpec([VIRT])], 'one command, one system each')
  assert.match(two, /^1\. kube-ovn:\n```sh\n/m)
  assert.match(two, /^2\. kubevirt:\n```sh\n/m)
  assert.match(p, /Never clone, fetch or download anything yourself/)
})

test('the answer is read per system asked for; a stray or malformed entry prepares nothing', () => {
  const st = readPrep({ systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }, { system: 'kubevirt', error: 'git failed: x' }, { system: 'other', ref: 'v1', dir: '/x' }] }, [OVN, VIRT])
  assert.deepEqual(st, { ran: true, prepared: [{ system: 'kube-ovn', ref: 'v1.13.2', dir: DIR }], failed: [{ system: 'kubevirt', error: 'git failed: x' }], unreachable: '' })
  assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn', error: 'x' }] }, [OVN]).failed, [{ system: 'kube-ovn', error: 'x' }])
  assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn' }] }, [OVN]).failed, [{ system: 'kube-ovn', error: 'no prepared directory in the answer' }])
  assert.equal(readPrep(null, [OVN]).unreachable, 'the source agent returned no answer')
  assert.equal(readPrep({ error: 'CRAFT_SOURCE: no usable copy' }, [OVN]).unreachable, 'CRAFT_SOURCE: no usable copy')
})

test('a directory is trusted only when absolute and ending with the cache path the engine computes from repo and ref', () => {
  const untrusted = [
    { ref: '-x', dir: DIR },
    { ref: 'v1.13.2', dir: 'home/u/.craft/sources/github.com/kubeovn/kube-ovn@v1.13.2' },
    { ref: 'v1.13.2', dir: '/home/u/.ssh' },
    { ref: 'v1.13.3', dir: DIR },
    { ref: 'v1.13.2', dir: '/x/github.com/kubevirt/kubevirt@v1.13.2' },
    { ref: 'v1.13.2', dir: '/x/evilgithub.com/kubeovn/kube-ovn@v1.13.2/..' },
    { ref: 'v1.13.2', dir: `/home/u/.ssh/..${DIR.slice('/home/u'.length)}` },
  ]
  for (const e of untrusted) assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn', ...e }] }, [OVN]).failed, [{ system: 'kube-ovn', error: 'prep answer not trusted' }], e.dir)
  assert.deepEqual(readPrep({ systems: [{ system: 'kube-ovn', ref: 'release/1.2', dir: '/c/github.com/kubeovn/kube-ovn@release~1.2' }] }, [OVN]).prepared, [{ system: 'kube-ovn', ref: 'release/1.2', dir: '/c/github.com/kubeovn/kube-ovn@release~1.2' }])
})
