// The discovery CLI's command line (lib/craft-externals-argv.mjs, realm @nick/craft, node #435): a malformed
// invocation refused before any file is read.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseArgv } from './craft-externals-argv.mjs'
import { base64url } from './external-source-spec.mjs'

test('a malformed invocation is refused before any file is read', () => {
  for (const argv of [['prepare'], ['discover', '--repo-root', 'rel'], ['discover', '--repo-root', '/x', '--known', 'f'], ['discover', '--repo-root', '/x', '--paths', 'not-b64!'], ['discover', '--repo-root', '/x', '--paths', base64url('["../x"]')], ['discover', '--repo-root', '/x', '--bogus', '1'], ['discover', '--repo-root']]) {
    assert.ok('error' in parseArgv(argv), argv.join(' '))
  }
})
