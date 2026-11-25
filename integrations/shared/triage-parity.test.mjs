// triage-findings as it runs today, held for the Rust port (realm @nick/craft, node #616) by one shared file,
// content/parity/triage-cases.json, which this test writes and cli/crates/craft-triage/src/parity.rs reads: per case the
// scripted answers, the prompts the engine dispatched, what it passed on to the plan agent, the record it filed and the
// plan it returned. The inputs are the file's; this test writes only the expected side. Without the env var it fails when the engine no longer produces the file's side byte for byte, the craft version in each record aside (realm @nick/craft, node #629):
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
  // The memory's sift: the scope check, the match judge and each rule judge, in the order asked.
  'decision-scope': answers.scope ?? null,
  'decision-match': answers.match ?? null,
  'rule-match': (/** @type {{ callIndex: number }} */ { callIndex }) => (answers.rules ?? [])[callIndex] ?? null,
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

// The schema each agent is handed is the content file it names, key for key; each agent kind is seen in some case.
const SCHEMAS = { 'gather:report': 'triage-raw', 'gather:pr': 'triage-raw', 'validate:': 'triage-validation', plan: 'triage-plan' }
/** @param {string} name */
const schemaFile = name => readFileSync(new URL(`../../content/schemas/${name}.schema.json`, import.meta.url), 'utf8')

/** Each dispatched agent's schema against its content file, by kind: the kinds seen. @param {Case} c @returns {Promise<string[]>} */
async function schemasSeen(c) {
  const r = await runEngine('triage-findings', { args: c.args, script: scriptOf(structuredClone(c.answers)) })
  /** @type {string[]} */
  const seen = []
  for (const [kind, name] of Object.entries(SCHEMAS)) {
    for (const call of r.calls.filter(x => x.label.startsWith(kind))) {
      const schema = /** @type {{ schema?: unknown }} */ (call.opts).schema
      assert.equal(JSON.stringify(schema), JSON.stringify(JSON.parse(schemaFile(name))), `${c.name}: ${call.label} is handed ${name}`)
      seen.push(kind)
    }
  }
  return seen
}

/**
 * The cases as written, the engine's version in each record put back to the one the file holds: a release moves the
 * engine's stamp and never this file, and the port reads the version from the file (realm @nick/craft, node #629).
 * @param {string} now @param {{ cases: Array<{ expected?: { record?: { craftVersion?: unknown } } }> }} before
 */
function atFileVersion(now, before) {
  /** @type {{ cases: Array<{ expected: { record: { craftVersion?: unknown } | null } }> }} */
  const file = JSON.parse(now)
  file.cases.forEach((c, i) => {
    const was = before.cases[i]?.expected?.record?.craftVersion
    if (c.expected.record && was !== undefined) c.expected.record.craftVersion = was
  })
  return `${JSON.stringify(file, null, 2)}\n`
}

// The inputs are the file's own — a new case is added there and its expected side written by this test. Compared as JSON
// text, so a key out of the engine's order fails as a wrong value does.
test('triage-cases.json is what the engine dispatches, files and returns', async () => {
  const before = JSON.parse(readFileSync(FILE, 'utf8'))
  /** @type {Case[]} */
  const inputs = before.cases.map((/** @type {Case} */ { name, args, answers }) => ({ name, args, answers }))
  /** @type {unknown[]} */
  const cases = []
  for (const c of inputs) cases.push({ ...c, expected: await expectedOf(c) })
  const now = `${JSON.stringify({ cases }, null, 2)}\n`
  if (process.env['UPDATE_TRIAGE_PARITY']) {
    writeFileSync(FILE, now)
    return
  }
  assert.equal(readFileSync(FILE, 'utf8'), atFileVersion(now, before), 'regenerate with UPDATE_TRIAGE_PARITY=1 after a change the port must follow')
})

test('every agent the cases dispatch is handed its schema from content/schemas', async () => {
  const inputs = /** @type {Case[]} */ (JSON.parse(readFileSync(FILE, 'utf8')).cases)
  /** @type {Set<string>} */
  const seen = new Set()
  for (const c of inputs) for (const kind of await schemasSeen(c)) seen.add(kind)
  assert.deepEqual([...seen].sort(), Object.keys(SCHEMAS).sort())
})
