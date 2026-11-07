import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SWITCH_ENV } from './role-hook.mjs'
import { saidInSession } from './work-hook-said.mjs'
import { OPENCODE_FINDINGS_TEXT, OPENCODE_REVIEW_TEXT, OPENCODE_SUBAGENT_TEXT, opencodeCompacted, opencodeMessage } from './work-hook-opencode.mjs'

const NOW = new Date('2026-10-21T12:00:00Z')
/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** A throwaway repo; `declared` gives it a project agent. @param {boolean} declared @returns {string} */
function repo(declared) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-oc-hook-')))
  made.push(root)
  fs.mkdirSync(path.join(root, '.git'))
  if (declared) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  }
  return root
}

/** @typedef {import('./hook-log.mjs').HookEntry} HookEntry */

test('a main session hears its class\'s lines once per class until a compaction, and each decision is logged', () => {
  const cwd = repo(true)
  /** @type {HookEntry[]} */
  const log = []
  const say = (/** @type {string} */ prompt, session = 's1') => {
    const r = opencodeMessage({ prompt, session, cwd }, {}, NOW, () => log)
    if (r.entry) log.push(r.entry)
    return r
  }
  const first = say('address the review findings')
  assert.equal(first.text, OPENCODE_FINDINGS_TEXT)
  assert.deepEqual(first.entry, { ts: NOW.toISOString(), repo: cwd, source: '', event: 'chat.message', harness: 'opencode', session: 's1', spoke: true, found: ['.claude/agents/dev.md'], silent: null, kind: 'findings' })
  assert.equal(say('more findings').entry?.silent, 'already-said')
  assert.equal(say('review it').text, OPENCODE_REVIEW_TEXT, 'the other class speaks its own text')
  assert.equal(say('review it again').entry?.silent, 'already-said')
  assert.equal(say('do a review', 's2').text, OPENCODE_REVIEW_TEXT, 'another session speaks')
  assert.deepEqual(say('write the parser'), { text: '', entry: null }, 'a prompt of no class is not logged')
  const reset = opencodeCompacted('s1', cwd, NOW, () => log)
  assert.deepEqual(reset && { event: reset.event, harness: reset.harness, session: reset.session, spoke: reset.spoke, silent: reset.silent }, { event: 'session.compacted', harness: 'opencode', session: 's1', spoke: false, silent: 'context-reset' })
  if (reset) log.push(reset)
  assert.equal(say('and the findings').text, OPENCODE_FINDINGS_TEXT, 'the compaction emptied the context: it speaks again')
  assert.equal(opencodeCompacted('quiet', cwd, NOW, () => log), null, 'a session that heard nothing logs no compaction')
})

test('the lines per kind name what the OpenCode delivery ships, not the Claude Code-only engines', () => {
  const counts = [[OPENCODE_FINDINGS_TEXT, 8], [OPENCODE_REVIEW_TEXT, 5], [OPENCODE_SUBAGENT_TEXT, 5]]
  for (const [text, n] of /** @type {[string, number][]} */ (counts)) {
    assert.equal(text.split('\n').length, n, text)
    assert.ok(text.split('\n').every(l => l.startsWith('craft: ')))
    assert.match(text, /addressing-findings/)
    assert.doesNotMatch(text, /craft:develop|craft:review\b|craft:memory|Workflow|Skill tool|Skill\(/)
    assert.ok(text.includes(`${SWITCH_ENV}=0`))
  }
  for (const text of [OPENCODE_FINDINGS_TEXT, OPENCODE_REVIEW_TEXT]) {
    assert.ok(text.startsWith('craft: before your first tool call on this request, make one call: '))
    assert.match(text, /craft: why: /)
    assert.match(text, /put the records the memory skill recalls, verbatim with their ids, into each brief, and record every triage disposition \(each finding rejected or deferred\) yourself, right after triage, never through a subagent, with the memory skill \(record-decision, record-rule or record-question\)/)
  }
  assert.match(OPENCODE_FINDINGS_TEXT, /make one call: load the addressing-findings skill with the skill tool\./)
  // No Workflow tool: the session does the sift itself; the triage-findings tool only validates (skills/addressing-findings, "Who triages").
  assert.match(OPENCODE_FINDINGS_TEXT, /^craft: triage the findings here in this session, never in a subagent, whatever their number: OpenCode has no sift engine, so do the sift steps of addressing-findings \("Who triages"\) yourself \(recall; .*a finding the PR did not introduce → an issue\), then validate the rest inline or with the triage-findings tool, which validates and plans but does not sift; record each disposition and file the issues yourself\.$/m)
  assert.match(OPENCODE_FINDINGS_TEXT, /paste this line verbatim into each fixer's brief with its file group: "Fix only: [^"]*addressing-findings skill \(skill tool\)[^"]*report each planned fix you find wrong, with its reason, in your result; never re-triage and never write memory: your launcher decides and records it\."/)
  assert.doesNotMatch(OPENCODE_FINDINGS_TEXT, /each subagent's brief/)
  assert.match(OPENCODE_REVIEW_TEXT, /make one call: for Rust code, load the rust-review skill with the skill tool, or call the rust-audit tool \(the \/rust-audit command\) for a whole crate\./)
  assert.match(OPENCODE_REVIEW_TEXT, /paste this line verbatim into its brief: "Review only: report findings only, change no code and record nothing; [^"]*"/)
})

test('the subagent lines: findings work loads addressing-findings and reports its verdicts, a reviewer only reports', () => {
  const lines = OPENCODE_SUBAGENT_TEXT.split('\n')
  for (const work of ['triaging PR comments', 'posting replies to review threads', 'fixing per review comments']) assert.ok(lines[0]?.includes(work), work)
  assert.match(lines[0] ?? '', /triage is never yours: the main session triages, doing the sift itself; a brief that asks you to triage: report that back and stop/)
  assert.match(lines[0] ?? '', /a file group of a triage plan: before your first tool call, load addressing-findings with the skill tool/)
  assert.match(OPENCODE_SUBAGENT_TEXT, /you lack the memory tools and never write memory: the records your launcher recalled are in your brief; report each planned fix you find wrong, with its reason, in your result/)
  assert.doesNotMatch(OPENCODE_SUBAGENT_TEXT, /record-decision|record each|delegating/)
  // A reviewer subagent is not sent into the fix loop (realm @nick/craft, #288).
  assert.match(OPENCODE_SUBAGENT_TEXT, /brief is only to review: report findings only, change no code and record nothing/)
})

test('silent where the start hook is: nothing declared, or switched off', () => {
  assert.equal(opencodeMessage({ prompt: 'review', session: 's', cwd: repo(false) }, {}, NOW, () => []).entry?.silent, 'nothing-declared')
  assert.equal(opencodeMessage({ prompt: 'review', session: 's', cwd: repo(true) }, { [SWITCH_ENV]: '0' }, NOW, () => []).entry?.silent, 'off-env')
  assert.deepEqual(opencodeMessage({ prompt: 'review', session: 'c', cwd: repo(false), parent: 'p', agent: 'general' }, {}, NOW, () => []), { text: '', entry: null })
})

test('a subagent hears its lines when its brief asks for review work or its parent heard the prompt lines', () => {
  const cwd = repo(true)
  /** @type {HookEntry} */
  const heard = { ts: NOW.toISOString(), repo: cwd, source: '', event: 'chat.message', session: 'p', spoke: true, found: [], silent: null, kind: 'review' }
  const brief = (/** @type {string} */ prompt, /** @type {HookEntry[]} */ log) => opencodeMessage({ prompt, session: 'c', cwd, parent: 'p', agent: 'general' }, {}, NOW, () => log)
  const byParent = brief('write the parser', [heard])
  assert.equal(byParent.text, OPENCODE_SUBAGENT_TEXT)
  assert.deepEqual(byParent.entry && { event: byParent.entry.event, session: byParent.entry.session, agent: byParent.entry.agent, kind: byParent.entry.kind }, { event: 'chat.message', session: 'p', agent: 'general', kind: undefined })
  assert.equal(brief('fix the PR comments', []).entry?.kind, 'findings', 'the brief itself names the work')
  assert.deepEqual(brief('write the parser', []), { text: '', entry: null })
  assert.deepEqual(brief('write the parser', [{ ...heard, agent: 'general' }]), { text: '', entry: null }, 'a subagent line is not the parent hearing')
})

test('saidInSession reads OpenCode lines: a main chat.message that spoke, reset by session.compacted', () => {
  /** @type {HookEntry} */
  const said = { ts: '', repo: '', source: '', event: 'chat.message', session: 's', spoke: true, found: [], silent: null }
  assert.equal(saidInSession([said], 's'), true)
  assert.equal(saidInSession([{ ...said, agent: 'general' }], 's'), false)
  assert.equal(saidInSession([said, { ...said, event: 'session.compacted', spoke: false }], 's'), false)
})
