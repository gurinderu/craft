// The submit and status commands every kind of run spells (integrations/shared/cli-step-commands.mjs), the kind's word in
// each.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { stepCommands } from './cli-step-commands.mjs'
import { submitCommand } from './cli-review-commands.mjs'

test("each command names the run kind's subcommand", () => {
  const triage = stepCommands('triage')
  assert.equal(triage.status('craft', '/r'), "craft triage status --run '/r'")
  assert.equal(triage.briefStatus('craft', '/r'), "craft triage status --run '/r' --brief")
  assert.equal(triage.submit('craft', '/r', {}), "craft triage submit --run '/r'")
})

test('a submit says only what differs from the binary default', () => {
  assert.equal(
    submitCommand('craft', '/r', { degraded: ['d'], abandoned: ['t'], limit: 'cap', resume: true, recordRoot: '/p' }, { agents: 3, tokens: 9 }),
    "craft review submit --run '/r' --degraded 'd' --abandoned 't' --limit 'cap' --resume --record-root '/p' --agents 3 --output-tokens 9 --output-tokens-scope turn-delta --paged",
  )
})
