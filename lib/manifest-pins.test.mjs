// Terraform git modules (lib/manifest-pins.mjs, realm @nick/craft, node #435).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { terraformCandidates } from './manifest-pins.mjs'
import { versionPattern } from './external-source-spec.mjs'

/** What `src` reads from `text`, compiled by the validated builder discovery uses. @param {string} src @param {string} text */
const read = (src, text) => {
  const p = versionPattern(src)
  if ('error' in p) throw new Error(p.error)
  return p.re.exec(text)?.[1]
}
test('a git-sourced module pinned by ref: the subdir cut from the repo, https only', () => {
  const tf = 'module "v" {\n  source = "git::https://github.com/o/vpc.git//modules/sub?ref=v5.1.0"\n}\nmodule "s" {\n  source = "git::ssh://git@github.com/o/thing.git?depth=1&ref=1.0.0"\n}\nmodule "r" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n'
  const got = terraformCandidates(tf.split('\n'))
  assert.deepEqual(got.map(c => [c.system, c.repo, c.version, read(c.versionMatch, tf)]), [
    ['vpc', 'https://github.com/o/vpc.git', 'v5.1.0', 'v5.1.0'],
    ['thing', '', '1.0.0', '1.0.0'],
  ])
})
