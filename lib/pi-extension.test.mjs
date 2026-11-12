// craft's pi extension against a stand-in pi: the tool it registers, run through the real bin/craft wrapper onto a
// fake binary (CRAFT_BIN) that prints a run's events and answer; pi's Text component replaced by a recording one.
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import craftReview, { summaryLines } from './pi-extension.mjs'
import { writeExecutable } from './write-executable.mjs'

vi.mock('@earendil-works/pi-tui', () => ({
  Text: class {
    /** @type {string} */
    text
    /** @param {string} text */
    constructor(text) {
      this.text = text
    }
  },
}))

const EVENTS = [
  { type: 'round', round: 1, phase: 'lenses', tasks: 1 },
  { type: 'task_started', id: 't1', label: 'a', agent: null, model: null, tier: 'opus' },
  { type: 'result', verdict: 'Block', report: '/r/report.md', run: '/r', findings: 1, exit_code: 0 },
]
const ANSWER = '## Verdict\n\n⛔ Block\n\n## Findings\n\n- [High] a.rs:3 — bug'
const THEME = { fg: (/** @type {string} */ c, /** @type {string} */ t) => `<${c}>${t}`, bold: (/** @type {string} */ t) => `*${t}*` }

/** @type {Record<string, any>} */
let tool = {}
const saved = process.env['CRAFT_BIN']

beforeEach(() => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-pi-')), 'craft')
  const events = EVENTS.map(e => `echo '${JSON.stringify(e)}' >&2`).join('\n')
  writeExecutable(bin, `#!/bin/sh\necho "$*" > "$(dirname "$0")/argv"\n${events}\nprintf '%s\\n' '${ANSWER}'\n`)
  process.env['CRAFT_BIN'] = bin
  craftReview({
    registerTool: t => {
      tool = t
    },
  })
})
afterEach(() => {
  if (saved === undefined) delete process.env['CRAFT_BIN']
  else process.env['CRAFT_BIN'] = saved
})

test('the tool runs the binary with the pi backend and its flags, streams progress and answers with the verdict', async () => {
  assert.equal(tool['name'], 'craft_review')
  /** @type {string[]} */
  const updates = []
  const result = await tool['execute']('id', { args: '--base main --depth light' }, undefined, (/** @type {any} */ r) => updates.push(r.content[0].text), {
    cwd: os.tmpdir(),
    hasUI: true,
  })
  const argv = fs.readFileSync(path.join(path.dirname(String(process.env['CRAFT_BIN'])), 'argv'), 'utf8').trim()
  assert.equal(argv, 'review run --backend pi --events json --base main --depth light')
  assert.deepEqual(updates, ['craft review: lenses, round 1 — 0 running, 0 done', 'craft review: lenses, round 1 — 1 running, 0 done'])
  assert.equal(result.content[0].text, ANSWER)
  assert.deepEqual(result.details.summary, { verdict: 'Block', report: '/r/report.md', run: '/r', findings: ['- [High] a.rs:3 — bug'] })
  assert.equal(result.isError, undefined)
  const drawn = tool['renderResult'](result, { isPartial: false, expanded: false }, THEME)
  assert.equal(drawn.text, '<error>*Block*\n<muted>- [High] a.rs:3 — bug\n<dim>report: /r/report.md')
})

test('without a UI no progress is sent: the answer is the plain text', async () => {
  /** @type {unknown[]} */
  const updates = []
  const result = await tool['execute']('id', {}, undefined, (/** @type {unknown} */ r) => updates.push(r), { cwd: os.tmpdir(), hasUI: false })
  assert.deepEqual(updates, [])
  assert.equal(result.content[0].text, ANSWER)
})

test('a run with no result event is an error result, drawn as its text', async () => {
  process.env['CRAFT_BIN'] = path.join(os.tmpdir(), 'no-such-craft')
  const result = await tool['execute']('id', {}, undefined, undefined, { cwd: os.tmpdir(), hasUI: true })
  assert.equal(result.isError, true)
  assert.match(
    result.content[0].text,
    /^## Verdict\n\nINCOMPLETE — the craft review gave no answer \(exit 127\):\n\ncraft: CRAFT_BIN=.* is not an executable file$/,
  )
  assert.match(tool['renderResult'](result, { isPartial: false, expanded: false }, THEME).text, /^<dim>## Verdict/)
})

test('findings past eight fold into a count unless expanded', () => {
  const findings = Array.from({ length: 10 }, (_, i) => `- f${i}`)
  const folded = summaryLines({ verdict: 'Approve', report: null, run: null, findings }, false, THEME)
  assert.equal(folded.length, 10)
  assert.equal(folded.at(-1), '<dim>… 2 more')
  assert.equal(summaryLines({ verdict: 'Approve', report: null, run: null, findings }, true, THEME).length, 11)
  assert.deepEqual(summaryLines({ verdict: 'Approve', report: null, run: null, findings: [] }, false, THEME), ['<success>*Approve*', '<muted>No findings.'])
})
