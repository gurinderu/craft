// The review's knowledge moved into content/ (realm @nick/craft, #445) renders byte-identical to the prompts and
// schemas the engine built before the move: every snapshot here was captured from the builders as they stood
// then, and a change to a prompt or schema's text is a change to its snapshot, made on purpose.
import { expect, test } from 'vitest'
import batchVerdictSchema from '../content/schemas/batch-verdict.schema.json' with { type: 'json' }
import dedupSchema from '../content/schemas/dedup.schema.json' with { type: 'json' }
test('the schemas the engine builds inside its phases are as before', () => {
  for (const [name, s] of Object.entries({ BATCH_VERDICT_SCHEMA: batchVerdictSchema, DEDUP_SCHEMA: dedupSchema })) expect(JSON.stringify(s, null, 1)).toMatchSnapshot(name)
})
