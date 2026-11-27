// The triage engine's arguments read for `craft triage start` (integrations/shared/cli-triage-options.mjs) and the start's
// command line (integrations/shared/cli-triage-commands.mjs): every refusal at once with its class, the lists as the JSON
// the binary reads, the paths kept for the agents to quote.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readTriageOptions } from './cli-triage-options.mjs'
import { triageStart } from './cli-triage-commands.mjs'

test('a relative path and a repo= no agent can cd to are refused together, each with its class', () => {
  const read = readTriageOptions({ report: '/r.md', repo: 'rel/repo', craftBin: 'bin/craft' })
  assert.ok('refused' in read, JSON.stringify(read))
  assert.equal(read.refused.length, 2)
  assert.match(read.refused[0]?.[0] ?? '', /^repo="rel\/repo" refused: /)
  assert.match(read.refused[1]?.[0] ?? '', /^craftBin="bin\/craft" refused: not an absolute path/)
})

test('the lists become the JSON the binary reads, a given string passed as it is', () => {
  const read = readTriageOptions({ pr: 7, priorLedger: [{ stable_id: 'a' }], priorDecisions: '[{"id":"decision-0123456789"}]', craftBin: '/b/craft' })
  assert.ok('options' in read, JSON.stringify(read))
  const o = read.options
  assert.deepEqual([o.pr, o.priorLedger, o.priorDecisions, o.craftBin, o.run], ['7', '[{"stable_id":"a"}]', '[{"id":"decision-0123456789"}]', '/b/craft', ''])
  const cmd = triageStart('/b/craft', o, '9.9.9', '')
  assert.equal(
    cmd,
    `/b/craft triage start --pr '7' --prior-ledger <(printf '%s' '[{"stable_id":"a"}]') --prior-decisions <(printf '%s' '[{"id":"decision-0123456789"}]') --record '9.9.9'`,
  )
})

test('nothing given beyond a source starts with only the source and the record', () => {
  const read = readTriageOptions({ report: '/r.md' })
  assert.ok('options' in read)
  assert.equal(triageStart('/b/craft', read.options, '9.9.9', '/p'), `/b/craft triage start --report '/r.md' --record '9.9.9' --record-root '/p'`)
})

for (const [key, values] of Object.entries({
  pr: [7, '7'],
  report: ['/r.md'],
  base: ['HEAD'],
  prBase: ['main'],
  priorLedger: [[], [{}], '[]', '[{}]'],
  priorDecisions: [[], [{}], '[]', '[{}]'],
})) {
  for (const value of values)
    test(`run refuses ${key}=${JSON.stringify(value)}`, () => {
      const read = readTriageOptions({ run: '/r/run', [key]: value })
      assert.ok('refused' in read, JSON.stringify(read))
      assert.ok(
        read.refused.some(([why]) => why.includes(`\`${key}\``) && why.includes('beside run=')),
        JSON.stringify(read),
      )
    })
}

test('resume keeps its repository and binary options, with no start options', () => {
  const read = readTriageOptions({ run: '/r/run', repo: '/repo', craftRoot: '/root', craftBin: '/bin/craft' })
  assert.ok('options' in read)
  assert.deepEqual([read.options.run, read.options.repo, read.options.craftRoot, read.options.craftBin], ['/r/run', '/repo', '/root', '/bin/craft'])
})
