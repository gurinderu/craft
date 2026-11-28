// The audit engine's refusals (integrations/shared/cli-audit-options.mjs, integrations/shared/cli-step-driver.mjs): an
// argument it cannot hand on is refused before any agent but the logger, and one the binary refuses at the start is
// filed in the binary's words; both file an INCOMPLETE record (realm @nick/craft, node #588).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { filedRecord, runEngine } from './engine-harness.mjs'
import { RESOLVED, labels, ran } from './audit-engine-script.mjs'

test('an argument the binary refuses at the start is filed as a refusal, in the binary’s words', async () => {
  const run = await runEngine('audit', {
    args: { path: 'nowhere' },
    script: { 'step:resolve': RESOLVED, 'step:start': ran('', 2, 'craft: the path "nowhere" holds no tracked file'), 'log-run': { ok: true } },
  })
  assert.match(run.report, /INCOMPLETE — audit: the path "nowhere" holds no tracked file\. Nothing ran\./)
  assert.deepEqual(filedRecord(run)?.notRun, ['an argument value audit cannot use was refused, nothing ran'])
})

for (const [name, args] of Object.entries({
  'an argument the engine does not take': { base: 'main' },
  'a budget of zero': { batchBytes: 0 },
  'a budget that is no whole number': { lensAgents: '1.5' },
  'a path holding a control character': { path: 'src\nrm' },
  'an empty path': { path: '' },
  'a blank path in a list': { path: ['src', ' '] },
  'a relative repo': { repo: 'rel' },
  'run= beside a start option': { run: '/r/run', path: 'src' },
}))
  test(`${name} is refused before any agent but the logger`, async () => {
    const run = await runEngine('audit', { args, script: { 'log-run': { ok: true } } })
    assert.deepEqual(labels(run), ['log-run'])
    assert.match(run.report, /^## Verdict\n⚠️ INCOMPLETE — /)
    assert.equal(filedRecord(run)?.verdict, 'INCOMPLETE (argument refused)')
  })
