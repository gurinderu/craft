// Getting the craft binary for any kind of run (integrations/shared/cli-step-binary.mjs): the engine named in what it says
// when the binary or the root is not to be got, the binary and root a fetch printed read back, a given craftBin run as is.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { binAndRoot } from './cli-step-binary.mjs'

const RELEASED = { craftBin: null, craftRoot: '', repo: '' }

/** A service step that answers every call with `got`, keeping the labels asked. @param {unknown} got */
function serving(got) {
  /** @type {string[]} */
  const asked = []
  /** @type {import('./cli-step-service.mjs').Serve} */
  const serve = label => {
    asked.push(label)
    return Promise.resolve(got)
  }
  return { serve, asked }
}

test('a fetch that failed is said in the engine’s name, with the local build as the way on', async () => {
  const { serve, asked } = serving({ exitCode: 1, stdout: '', stderr: 'craft-bin: no released craft binary for freebsd/x64' })
  const got = await binAndRoot('triage', RELEASED, '9.9.9', serve)
  assert.deepEqual(asked, ['step:resolve'])
  assert.ok('incomplete' in got && got.incomplete.startsWith('triage could not get the craft binary 9.9.9: '), JSON.stringify(got))
  assert.ok('incomplete' in got && got.incomplete.endsWith('Pass craftBin=<absolute path> of a build (`cargo build --release` in cli/).'))
})

test('the usage limit stopping the fetch says to run the engine again after the reset', async () => {
  const { serve } = serving({ limit: "You've hit your weekly limit" })
  const got = await binAndRoot('triage', RELEASED, '9.9.9', serve)
  assert.ok('incomplete' in got, JSON.stringify(got))
  assert.equal(got.cause, 'limit')
  assert.ok(
    got.incomplete.endsWith(
      "Run the triage again once the limit resets: a local build does not lift the limit — the triage's agents answer from the same account.",
    ),
    got.incomplete,
  )
})

test('a fetch that printed its root and binary hands both back', async () => {
  const { serve } = serving({ exitCode: 0, stdout: 'root=/p/craft\nbin=/home/u/.craft/bin/9.9.9/craft\n', stderr: '' })
  assert.deepEqual(await binAndRoot('triage', RELEASED, '9.9.9', serve), { bin: '/home/u/.craft/bin/9.9.9/craft', root: '/p/craft' })
})

test('a given craftRoot that is no plugin root is named in the engine’s words', async () => {
  const { serve, asked } = serving({ exitCode: 1, stdout: '', stderr: 'no manifest' })
  const got = await binAndRoot('triage', { craftBin: '/b/craft', craftRoot: '/nope', repo: '' }, '9.9.9', serve)
  assert.deepEqual(asked, ['step:root'])
  assert.ok('incomplete' in got && got.incomplete.startsWith('triage: craftRoot="/nope" is not a usable plugin root: '), JSON.stringify(got))
})

test('beside a given craftBin with no craftRoot, the root is located only to file the run through', async () => {
  const given = { craftBin: '/b/craft', craftRoot: '', repo: '' }
  const found = serving({ exitCode: 0, stdout: 'root=/p/craft\n', stderr: '' })
  assert.deepEqual(await binAndRoot('triage', given, '9.9.9', found.serve), { bin: '/b/craft', root: '', recordRoot: '/p/craft' })
  assert.deepEqual(found.asked, ['step:locate'])
  const none = serving({ exitCode: 1, stdout: '', stderr: 'no usable plugin root' })
  const got = await binAndRoot('triage', given, '9.9.9', none.serve)
  assert.ok('note' in got && got.bin === '/b/craft' && got.root === '', JSON.stringify(got))
})

test('a given craftRoot the check accepts is handed to the binary', async () => {
  const { serve } = serving({ exitCode: 0, stdout: 'root=/p/craft\n', stderr: '' })
  assert.deepEqual(await binAndRoot('triage', { craftBin: '/b/craft', craftRoot: '/p/craft', repo: '' }, '9.9.9', serve), { bin: '/b/craft', root: '/p/craft' })
})
