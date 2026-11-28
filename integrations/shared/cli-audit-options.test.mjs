// The audit engine's arguments read for `craft audit start` (integrations/shared/cli-audit-options.mjs) and the start's
// command line (integrations/shared/cli-audit-commands.mjs): every refusal at once with its class, the paths as given,
// the budgets as the digits the binary reads.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readAuditOptions } from './cli-audit-options.mjs'
import { auditStart } from './cli-audit-commands.mjs'

/** @param {Record<string, unknown>} a */
const options = a => {
  const read = readAuditOptions(a)
  assert.ok('options' in read, JSON.stringify(read))
  return read.options
}

test('one path, a list of paths, or none: each as given, a number read as its digits', () => {
  assert.deepEqual(options({ path: 'src' }).paths, ['src'])
  assert.deepEqual(options({ path: ['src', 'lib dir', '-dash'] }).paths, ['src', 'lib dir', '-dash'])
  assert.deepEqual(options({ path: 7 }).paths, ['7'])
  assert.deepEqual(options({}).paths, [])
})

test('the budgets are the digits the binary reads, from a number or a string', () => {
  const o = options({ batchBytes: 150000, lensAgents: ' 4 ' })
  assert.deepEqual([o.batchBytes, o.lensAgents], ['150000', '4'])
  assert.deepEqual([options({}).batchBytes, options({}).lensAgents], ['', ''])
})

for (const [key, value] of Object.entries({ batchBytes: 0, lensAgents: -1 }))
  test(`${key}=${value} is refused with the budget class`, () => {
    const read = readAuditOptions({ [key]: value })
    assert.ok('refused' in read)
    assert.deepEqual(
      read.refused.map(([, cls]) => cls),
      ['a budget argument refused — not a positive whole number, nothing ran'],
    )
  })

for (const value of ['1.5', 'ten', true, [3], '0x10', '1e3', 1.5])
  test(`a budget of ${JSON.stringify(value)} is refused`, () => {
    assert.ok('refused' in readAuditOptions({ lensAgents: value }))
  })

for (const value of ['', ' ', null, ['src', ''], 'a\tb', ['ok', { p: 1 }], [], true])
  test(`path=${JSON.stringify(value)} is refused`, () => {
    const read = readAuditOptions({ path: value })
    assert.ok('refused' in read, JSON.stringify(read))
    assert.match(read.refused[0]?.[1] ?? '', /^`path` refused/)
  })

test('every refusal at once: an unknown argument, start options beside run=, a bad budget and a relative repo', () => {
  const read = readAuditOptions({ run: '/r/run', path: 'src', batchBytes: 'x', repo: 'rel', depth: 'light' })
  assert.ok('refused' in read)
  assert.equal(read.refused.length, 4, JSON.stringify(read.refused))
  assert.match(read.refused[0]?.[0] ?? '', /audit cannot honour `depth`/)
  assert.match(read.refused[1]?.[0] ?? '', /`path`, `batchBytes` beside run=/)
  assert.match(read.refused[2]?.[0] ?? '', /^batchBytes="x" refused/)
  assert.match(read.refused[3]?.[0] ?? '', /^repo="rel" refused/)
})

test('a resume keeps its repository and binary options, with no start options', () => {
  const o = options({ run: '/r/run', repo: '/repo', craftRoot: '/root', craftBin: '/bin/craft' })
  assert.deepEqual([o.run, o.repo, o.craftRoot, o.craftBin, o.paths], ['/r/run', '/repo', '/root', '/bin/craft', []])
})

test('the start quotes each path whole after `--path=`, so a path with a quote or a leading dash stays one value', () => {
  const o = options({ path: ["it's", '-x'], repo: '/w' })
  assert.equal(auditStart('/b/craft', o, '9.9.9', '', ''), `/b/craft audit start --cwd '/w' --path='it'\\''s' --path='-x' --record '9.9.9'`)
})
