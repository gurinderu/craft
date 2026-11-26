// The light review-task agent's context on OpenCode 2.x (light-agent.ts), over model requests shaped as opencode 2.2.7
// handed them to a probe plugin's `context` and `compaction` hooks (realm @nick/craft, node #697): four system parts,
// the messages, and `tools` as a record — changed in place, the one change the host keeps.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { hookLightAgent, lighten } from './light-agent.ts'
import { TASK_AGENT } from './review-children.ts'

/** @typedef {import('./opencode-v2.js').V2ContextHookInput} Request */
/** @typedef {import('./opencode-v2.js').V2SystemPart} SystemPart */
/** @typedef {import('./opencode-v2.js').V2ModelMessage} Message */

const PROMPT = "You run exactly one task of craft's review, handed to you by the review driver."
const MODEL_NOTE = '# Your Model\n- Name: fake-model\n- Provider ID: fake\n- Model ID: fake-model'
const WORKTREE_NOTE = 'When you create a worktree outside the current working directory, make it the working one.'
const RULES = 'Instructions from: /probe/proj/AGENTS.md\n# Probe project rules\n\nPROBE-PROJECT-RULES-MARKER-7f3a\n\nAlways answer with the word PINEAPPLE.\n'
const DATE = "Today's date: Thu Nov 26 2026"
const ENV_HEAD = 'Here is some useful information about the environment you are running in:'
const ENV = `${ENV_HEAD}\n<env>\n  Working directory: /probe/proj\n  Platform: linux\n</env>`
const OWN = `${DATE}\n\n${ENV}`
const KEYS = ['core/instructions', 'core/date', 'core/environment']
const TOOL = { description: 'a tool', input: { type: 'object' } }
const RULES_OF_THE_REPOSITORY = /PROBE-PROJECT-RULES-MARKER|PROBE-SUB-RULES-MARKER|Instructions from:|PINEAPPLE/

/**
 * The system part that carries the repository's instructions: the section texts joined by blank lines, each named
 * under `metadata`.
 * @param {string[]} keys
 * @param {string[]} texts
 * @returns {SystemPart}
 */
function contexts(keys, texts) {
  const instructions = keys.map((key, i) => ({ key, text: /** @type {string} */ (texts[i]) }))
  return { type: 'text', text: texts.join('\n\n'), metadata: { experimental: { instructions } } }
}

/** A message as the hook saw the task and the notices: one text part. @param {string} role @param {string} text @param {{ id?: string }} [extra] */
function textMessage(role, text, extra = {}) {
  return { role, content: [{ type: 'text', text }], ...extra }
}

/** A model request as the probe recorded it. @param {string} [agent] @returns {Request} */
function request(agent = TASK_AGENT) {
  return {
    sessionID: 'ses_1',
    agent,
    model: { id: 'fake-model', providerID: 'fake' },
    options: { maxTokens: 32000 },
    system: [{ type: 'text', text: PROMPT }, { type: 'text', text: MODEL_NOTE }, contexts(KEYS, [RULES, DATE, ENV]), { type: 'text', text: WORKTREE_NOTE }],
    messages: [textMessage('user', 'Review the change in lib/ and answer as one JSON object.', { id: 'msg_1' })],
    tools: { glob: TOOL, grep: TOOL, read: TOOL, shell: TOOL, write: TOOL, skill: TOOL, webfetch: TOOL },
  }
}

/** The request's instructions part, the third of four. @param {Request} input @returns {SystemPart} */
function instructionsPart(input) {
  return /** @type {SystemPart} */ (input.system?.[2])
}

/** Every text the request still offers the model, system parts and messages alike. @param {Request} input */
function textsOf(input) {
  const ofMessage = (/** @type {Message} */ m) => (typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('\n'))
  return [...(input.system ?? []).map(p => p.text), ...(input.messages ?? []).map(ofMessage)]
}

/** A 2.x context's `session.hook` alone: the callbacks it was given, by name. `refuse` names the one it refuses, or `true` for every.
 * @param {boolean | string} [refuse] */
function fakeHooks(refuse = false) {
  /** @type {Record<string, (input: any) => unknown>} */
  const callbacks = {}
  let disposed = 0
  const registration = {
    dispose: () => {
      disposed++
      return Promise.resolve()
    },
  }
  const ctx = /** @type {import('./opencode-v2.js').V2Context} */ (
    /** @type {unknown} */ ({
      session: {
        hook: (/** @type {string} */ name, /** @type {any} */ callback) => {
          if (refuse === true || refuse === name) return Promise.reject(new Error('session.hook is not a function'))
          callbacks[name] = callback
          return Promise.resolve(registration)
        },
      },
    })
  )
  return { ctx, callbacks, disposed: () => disposed }
}

test("review-task's request keeps the host's date and environment, and nothing of the repository's rules", () => {
  const input = request()
  const part = instructionsPart(input)
  const rest = /** @type {SystemPart[]} */ ([input.system?.[0], input.system?.[1], input.system?.[3]])
  const restTexts = rest.map(p => p.text)
  lighten(input)
  assert.equal(part.text, OWN)
  assert.deepEqual(
    part.metadata?.experimental?.instructions?.map(i => i.key),
    ['core/date', 'core/environment'],
    'the list the host keeps beside the text says the same as the text',
  )
  assert.equal(input.system?.length, 4)
  assert.deepEqual(
    rest.map(p => p.text),
    restTexts,
    'the agent prompt, the model note and the worktree note stay',
  )
  const system = /** @type {SystemPart[]} */ (input.system)
  assert.ok(
    system.every(p => p === part || rest.includes(p)),
    'no part is replaced by another',
  )
  for (const text of textsOf(input)) assert.doesNotMatch(text, RULES_OF_THE_REPOSITORY)
})

test('a date and an environment quoted inside the rules are not kept, whichever way the part is read', () => {
  const quoted = OWN.replaceAll('/probe/proj', '/other/proj')
  const quoting = `${RULES}\n\nAnother project's context, for comparison:\n${quoted}`
  const text = [quoting, DATE, ENV].join('\n\n')
  const byList = request()
  byList.system?.splice(2, 1, contexts(KEYS, [quoting, DATE, ENV]))
  const byUntrustedList = request()
  byUntrustedList.system?.splice(2, 1, { ...contexts(KEYS, [RULES, DATE, ENV]), text })
  const byText = request()
  byText.system?.splice(2, 1, { type: 'text', text })
  for (const input of [byList, byUntrustedList, byText]) {
    lighten(input)
    assert.equal(instructionsPart(input).text, OWN)
    assert.equal(input.system?.length, 4)
  }
})

test('a part whose list no longer accounts for its text is read by its text, and the list is left alone', () => {
  const input = request()
  const part = instructionsPart(input)
  part.text = `${RULES}\nExtra from a newer host.\n\n${DATE}\n\n${ENV}`
  const list = part.metadata?.experimental?.instructions
  lighten(input)
  assert.equal(part.text, OWN)
  assert.equal(part.metadata?.experimental?.instructions, list, 'a list that was not trusted is not rewritten')
})

test('an instructions part that cannot be cut is removed from the request, not sent with the rules', () => {
  const rulesLast = request()
  instructionsPart(rulesLast).text = `${ENV}\n\n${RULES}`
  const appended = request()
  instructionsPart(appended).text += '\n\nAppended by a newer host.'
  const nothingOwn = request()
  nothingOwn.system?.splice(2, 1, contexts(['core/instructions', 'core/skills'], [RULES, 'Skills available: none']))
  for (const input of [rulesLast, appended, nothingOwn]) {
    const kept = /** @type {SystemPart[]} */ (input.system?.filter(p => p.metadata === undefined))
    const before = kept.map(p => p.text)
    lighten(input)
    assert.deepEqual(input.system, kept, 'the other parts stay, in their order')
    assert.deepEqual(
      kept.map(p => p.text),
      before,
    )
  }
})

test('a rule file the host loads on the way is dropped from the messages, and the task stays', () => {
  const SUB_RULES = 'Instructions from: /probe/proj/sub/AGENTS.md\n# Sub project rules\n\nPROBE-SUB-RULES-MARKER-9c1d'
  const inParts = request()
  inParts.messages?.push(textMessage('user', SUB_RULES, { id: 'msg_9' }))
  const inString = request()
  inString.messages?.push({ id: 'msg_9', role: 'user', content: SUB_RULES })
  for (const input of [inParts, inString]) {
    const task = input.messages?.[0]
    lighten(input)
    assert.deepEqual(input.messages, [task])
  }
})

test("an instruction change's notice is dropped; a system message that is not only text and a compaction summary stay", () => {
  const input = request()
  const task = input.messages?.[0]
  assert.ok(task, 'the request carries the task')
  const call = { id: 'msg_3', role: 'assistant', content: [{ type: 'tool-call', toolName: 'read' }] }
  const result = { role: 'tool', content: [{ type: 'tool-result', toolName: 'read' }] }
  const effort = { role: 'system', content: [{ type: 'effort', effort: 'high' }] }
  const summary = textMessage('user', '<conversation-checkpoint>\nEarlier, the assistant read lib/a.ts.\n</conversation-checkpoint>', {
    id: 'msg_5',
  })
  input.messages = [
    textMessage('system', `The instructions changed:\n${RULES}`),
    task,
    call,
    result,
    textMessage('system', 'Previously loaded instructions no longer apply.'),
    effort,
    summary,
  ]
  lighten(input)
  assert.deepEqual(input.messages, [task, call, result, effort, summary])
})

test('with no date line before the environment, the last line of the rules is not taken for the date', () => {
  const text = `${RULES}\n\n${ENV}`
  const untrustedList = request()
  untrustedList.system?.splice(2, 1, { ...contexts(KEYS, [RULES, DATE, ENV]), text })
  const byText = request()
  byText.system?.splice(2, 1, { type: 'text', text })
  for (const input of [untrustedList, byText]) {
    lighten(input)
    assert.equal(instructionsPart(input).text, ENV)
  }
})

test('only a user message that begins as a rule file goes: one that quotes the marker, and a reply that begins with it, stay', () => {
  const quoting = textMessage('user', 'The file says "Instructions from: /probe/proj/sub/AGENTS.md" at its top.', { id: 'msg_7' })
  const reply = textMessage('assistant', 'Instructions from: /probe/proj/sub/AGENTS.md was loaded; the note says KIWI.', {
    id: 'msg_8',
  })
  const input = request()
  const task = input.messages?.[0]
  input.messages = [task, quoting, reply]
  lighten(input)
  assert.deepEqual(input.messages, [task, quoting, reply])
})

test("another agent's request passes as it came", () => {
  const input = request('general')
  const before = structuredClone(input)
  const { system, messages, tools } = input
  lighten(input)
  assert.deepEqual(input, before)
  assert.ok(input.system === system && input.messages === messages && input.tools === tools)
})

test('four tools are offered by the same record; a list of tools is not read as one', () => {
  const input = request()
  const { tools } = input
  // The host's hand is not the interface's promise: a list where a record is due.
  const listed = request()
  Object.assign(listed, { tools: [{ name: 'glob' }, { name: 'write' }] })
  lighten(input)
  lighten(listed)
  assert.equal(input.tools, tools)
  assert.deepEqual(Object.keys(input.tools ?? {}).sort(), ['glob', 'grep', 'read', 'shell'])
  assert.equal(listed.tools?.['length'], 2)
})

test("the hook lightens review-task's requests on `context`, passes every other agent's, and is disposed with the plugin", async () => {
  const f = fakeHooks()
  const dispose = await hookLightAgent(f.ctx, () => {})
  assert.deepEqual(Object.keys(f.callbacks), ['context', 'compaction'])
  const light = request()
  const other = request('general')
  const otherBefore = JSON.stringify(other)
  f.callbacks['context']?.(light)
  f.callbacks['context']?.(other)
  assert.equal(instructionsPart(light).text, OWN)
  assert.deepEqual(Object.keys(light.tools ?? {}).sort(), ['glob', 'grep', 'read', 'shell'])
  assert.equal(JSON.stringify(other), otherBefore)
  await dispose()
  assert.equal(f.disposed(), 2)
})

test('a compaction request is lightened the same way: the rule file the host stored and the notices go, the rest of the conversation stays', async () => {
  const f = fakeHooks()
  const dispose = await hookLightAgent(f.ctx, () => {})
  const SUB_RULES = 'Instructions from: /probe/proj/sub/AGENTS.md\n# Sub project rules\n\nPROBE-SUB-RULES-MARKER-9c1d'
  // Shaped as the probe recorded the `compaction` hook's input: the conversation as the host stored it, before it appends
  // the summarizer's instruction (node #697).
  const compaction = request()
  compaction.options = { maxTokens: 30000 }
  compaction.tools = { ...compaction.tools, review: TOOL, 'rust-audit': TOOL, 'triage-findings': TOOL }
  const task = textMessage('user', 'Read the note in sub/ and report it.', { id: 'msg_1' })
  const call = {
    id: 'msg_2',
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call_fake_1', name: 'read', input: { path: '/probe/proj/sub/note.txt' }, providerExecuted: false }],
  }
  const result = {
    role: 'tool',
    content: [{ type: 'tool-result', id: 'call_fake_1', name: 'read', result: { type: 'text', value: 'A plain note.' }, providerExecuted: false }],
  }
  const answer = textMessage('assistant', 'DONE-SUB', { id: 'msg_3' })
  compaction.messages = [
    task,
    call,
    result,
    textMessage('user', SUB_RULES, { id: 'msg_4' }),
    textMessage('system', `The instructions changed:\n${RULES}`),
    answer,
  ]
  f.callbacks['compaction']?.(compaction)
  assert.equal(instructionsPart(compaction).text, OWN)
  assert.deepEqual(Object.keys(compaction.tools ?? {}).sort(), ['glob', 'grep', 'read', 'shell'])
  assert.deepEqual(compaction.messages, [task, call, result, answer])
  for (const text of textsOf(compaction)) assert.doesNotMatch(text, RULES_OF_THE_REPOSITORY)
  const other = request('general')
  const otherBefore = JSON.stringify(other)
  f.callbacks['compaction']?.(other)
  assert.equal(JSON.stringify(other), otherBefore, "another agent's compaction passes as it came")
  await dispose()
})

test('a 2.x that refuses the compaction hook keeps the context one, and says the refusal once', async () => {
  /** @type {string[]} */
  const logged = []
  const f = fakeHooks('compaction')
  const dispose = await hookLightAgent(f.ctx, line => logged.push(line))
  assert.deepEqual(Object.keys(f.callbacks), ['context'])
  assert.deepEqual(logged, ["craft: could not lighten the review-task agent's context on this OpenCode: compaction hook: session.hook is not a function"])
  const light = request()
  f.callbacks['context']?.(light)
  assert.equal(instructionsPart(light).text, OWN)
  await dispose()
  assert.equal(f.disposed(), 1)
})

test('a request that cannot be read costs the host nothing, and each reason is logged once', async () => {
  /** @type {string[]} */
  const logged = []
  const f = fakeHooks()
  const dispose = await hookLightAgent(f.ctx, line => logged.push(line))
  const fire = /** @type {(input: unknown) => void} */ (f.callbacks['context'])
  const unreadable = {
    type: 'text',
    text: 'x',
    metadata: {
      get experimental() {
        throw new Error('metadata is sealed')
      },
    },
  }
  const requests = [
    null,
    undefined,
    7,
    {},
    { agent: 'review-task' },
    { agent: 'review-task', system: [null, 5, { type: 'text' }, { type: 'text', text: 'x', metadata: 7 }] },
    { agent: 'review-task', messages: [null, 3, {}, { role: 5, content: 'Instructions from: /x' }] },
    { agent: 'review-task', tools: ['glob'], system: 'not a list', messages: 'not a list' },
    { agent: 'review-task', system: [{ type: 'text', text: 5 }] },
    { agent: 'review-task', system: [unreadable, unreadable] },
  ]
  for (const bad of requests) {
    assert.doesNotThrow(() => fire(bad))
    assert.doesNotThrow(() => fire(bad))
  }
  assert.deepEqual(logged, ["craft: could not lighten the review-task agent's context on this OpenCode: metadata is sealed"])
  await dispose()
})

test('a refusal to register a hook is logged once per hook and leaves a disposer that resolves', async () => {
  /** @type {string[]} */
  const logged = []
  const f = fakeHooks(true)
  const dispose = await hookLightAgent(f.ctx, line => logged.push(line))
  const line = "craft: could not lighten the review-task agent's context on this OpenCode: "
  assert.deepEqual(logged, [`${line}context hook: session.hook is not a function`, `${line}compaction hook: session.hook is not a function`])
  await dispose()
  assert.equal(f.disposed(), 0)
})
