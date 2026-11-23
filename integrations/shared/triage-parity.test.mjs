// triage-findings as it runs today, held for the Rust port (realm @nick/craft, node #616) by one shared file,
// content/parity/triage-cases.json, which this test writes and cli/crates/craft-triage/src/parity.rs reads: per case the
// scripted answers, the prompts the engine dispatched, what it passed on to the plan agent, the record it filed and the
// plan it returned. The inputs are the file's; this test writes only the expected side. Without the env var it fails when the engine no longer produces the file's side byte for byte:
// `UPDATE_TRIAGE_PARITY=1 npx vitest run --config integrations/shared/config/vitest.config.mjs integrations/shared/triage-parity.test.mjs`.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { runEngine, filedRecord } from './engine-harness.mjs'

const FILE = new URL('../../content/parity/triage-cases.json', import.meta.url)

/** A case's input: the engine's arguments and the agents' answers. @typedef {{ name: string, args: Record<string, unknown>, answers: any }} Case */
// The recall every case answers unless it scripts its own: read, nothing recalled.
const MEMORY = { backend: 'mcp iskron', why: 'recalled', decisions: [] }

/** The answers a case scripts, as the harness takes them: a validator by the stable id its prompt names. @param {any} answers */
const scriptOf = answers => ({
  'log-run': { ok: true },
  'gather:report': answers.report ?? null,
  'gather:pr': answers.pr ?? null,
  'memory-recall': answers.memoryRecall ?? MEMORY,
  validate: (/** @type {{ prompt: string }} */ { prompt }) => answers.validate[/stable_id MUST be exactly: (.*)/.exec(prompt)?.[1] ?? ''] ?? null,
  plan: answers.plan ?? null,
})

/** The three JSON blocks the plan prompt hands its agent, each after its heading line; none without a plan prompt. @param {string} prompt */
function planBlocks(prompt) {
  if (!prompt) return { accepted: null, validations: null, sifted: null }
  const heads = ['\n\nACCEPTED (with their', '\n\nALL VERDICTS (', '\n\nSETTLED BEFORE VALIDATION (']
  const at = heads.map(h => prompt.lastIndexOf(h))
  const block = (/** @type {number} */ i) => {
    const from = prompt.indexOf('\n', (at[i] ?? 0) + 2) + 1
    return JSON.parse(prompt.slice(from, at[i + 1] ?? prompt.length))
  }
  return { accepted: block(0), validations: block(1), sifted: block(2) }
}

/** One case run, everything it dispatched and returned that the port is held to. @param {Case} c */
async function expectedOf(c) {
  const r = await runEngine('triage-findings', { args: c.args, script: scriptOf(structuredClone(c.answers)) })
  const of = (/** @type {(l: string) => boolean} */ pick) => Object.fromEntries(r.calls.filter(x => pick(x.label)).map(x => [x.label, x.prompt]))
  const plan = r.calls.find(x => x.label === 'plan')
  const validates = r.calls.filter(x => x.label.startsWith('validate:'))
  return {
    prompts: {
      gather: of(l => l.startsWith('gather:')),
      validate: Object.fromEntries(validates.map(x => [/stable_id MUST be exactly: (.*)/.exec(x.prompt)?.[1], x.prompt])),
      plan: plan?.prompt ?? null,
    },
    ...planBlocks(plan?.prompt ?? ''),
    record: filedRecord(r),
    plan: r.reportValue,
  }
}

/** The answer schemas, as the gather, validate and plan agents were handed them in a case that runs all three.
@param {Case} c */
async function schemasOf(c) {
  const r = await runEngine('triage-findings', { args: c.args, script: scriptOf(structuredClone(c.answers)) })
  const schema = (/** @type {string} */ label) => /** @type {{ schema?: unknown } | undefined} */ (r.calls.find(x => x.label.startsWith(label))?.opts)?.schema
  return { raw: schema('gather:'), validation: schema('validate:'), plan: schema('plan') }
}

// The inputs are the file's own — a new case is added there and its expected side written by this test.
test('triage-cases.json is what the engine dispatches, files and returns', async () => {
  const file = JSON.parse(readFileSync(FILE, 'utf8'))
  /** @type {Case[]} */
  const inputs = file.cases.map((/** @type {Case} */ { name, args, answers }) => ({ name, args, answers }))
  /** @type {unknown[]} */
  const cases = []
  for (const c of inputs) cases.push({ ...c, expected: await expectedOf(c) })
  const now = JSON.parse(
    JSON.stringify({ schemas: await schemasOf(inputs.find(c => c.name === 'class 1 with a prBase') ?? { name: '', args: {}, answers: {} }), cases }),
  )
  if (process.env['UPDATE_TRIAGE_PARITY']) writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`)
  assert.deepEqual(file.schemas, now.schemas, 'the answer schemas')
  assert.deepEqual(file.cases, now.cases, 'regenerate with UPDATE_TRIAGE_PARITY=1 after a change the port must follow')
})
