import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookLogPath, readHookLog } from './hook-log.mjs'
import { SWITCH_ENV } from './role-hook.mjs'
import { agentFrontmatter, isReviewer, reviewerDispatchHook, REVIEWER_REASON } from './reviewer-dispatch-hook.mjs'
import { run } from './reviewer-dispatch-hook-entry.mjs'

const NOW = new Date('2026-10-30T12:00:00Z')

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @returns {string} */
function tmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-reviewer-hook-')))
  made.push(dir)
  return dir
}

const agentFile = (/** @type {string} */ name, /** @type {string} */ description) => `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`

/** A throwaway repo with a project reviewer, a non-review agent and `extra` files. @param {Record<string, string>} [extra] */
function repo(extra = {}) {
  const root = tmp()
  fs.mkdirSync(path.join(root, '.git'))
  const files = {
    '.claude/agents/checker.md': agentFile('code-checker', 'Cold review of a finished batch — reads the diff.'),
    '.claude/agents/designer.md': agentFile('designer', 'Bulky judgment work — projecting files. Not for review and acceptance (reviewer, verifier).'),
    ...extra,
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

/** The probe-observed input shape (Claude Code 2.1.309). @param {string} cwd @param {Record<string, unknown>} toolInput @param {Record<string, unknown>} [more] */
const call = (cwd, toolInput, more = {}) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Review', prompt: 'Review the branch', ...toolInput }, ...more })

/** @param {string} stdout @returns {string} */
const said = stdout => /** @type {{ hookSpecificOutput: { additionalContext: string } }} */ (JSON.parse(stdout)).hookSpecificOutput.additionalContext

test('frontmatter: name and description, quoted or folded', () => {
  assert.deepEqual(agentFrontmatter(agentFile('r', '"Reviews code."')), { name: 'r', description: 'Reviews code.' })
  assert.deepEqual(agentFrontmatter('---\nname: r\ndescription: >\n  Cold review\n  of a batch.\ntools: Read\n---\n'), { name: 'r', description: 'Cold review of a batch.' })
  assert.deepEqual(agentFrontmatter('no frontmatter'), { name: '', description: '' })
})

test('a reviewer by its name or the first clause of its description, not by a later "not for review"', () => {
  assert.ok(isReviewer({ name: 'reviewer', description: '' }))
  assert.ok(isReviewer({ name: 'checker', description: 'Reviews the diff; returns findings.' }))
  assert.ok(!isReviewer({ name: 'designer', description: 'Bulky work. Not for review (reviewer).' }))
  assert.ok(!isReviewer({ name: 'verifier', description: 'Cold acceptance of a claim — not for reviewing design.' }))
})

test('the project reviewer dispatched in the background: launch the engine now, in parallel, and fold its findings', () => {
  const root = repo()
  const r = reviewerDispatchHook(call(root, { subagent_type: 'code-checker', run_in_background: true }), {}, os.tmpdir(), NOW)
  const text = said(r.stdout)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(text, /code-checker is this repo's own reviewer \(\.claude\/agents\/checker\.md\)/)
  assert.match(text, /craft:review workflow \{ base: <the same base>, fresh: true, fullEvery: 0 \} when that diff .* Rust and\/or Nix only/)
  assert.match(text, /craft:adversarial-review workflow \{ diffBase: <the same base> \} on any other/)
  assert.match(text, /launch the engine now, in parallel, not after it returns/)
  assert.match(text, /fold the engine's findings into code-checker's verdict .* Medium-or-higher finding from either side/)
  assert.match(text, /craft-log-run\.mjs" enrich-cost --run-id/)
  assert.match(text, /CRAFT_ROLE_HOOK=0/)
  assert.deepEqual(r.entry, { ts: NOW.toISOString(), repo: root, source: '', event: 'PreToolUse', harness: 'claude-code', session: 's1', spoke: true, found: ['.claude/agents/checker.md', '.claude/agents/designer.md'], silent: null, agent: 'code-checker', reason: REVIEWER_REASON })
})

test('a foreground reviewer, found by its file name when it has no frontmatter name, gets the foreground wording', () => {
  const root = repo({ '.claude/agents/reviewer.md': '---\ndescription: Reviews the branch.\n---\n' })
  const text = said(reviewerDispatchHook(call(root, { subagent_type: 'reviewer' }), {}, os.tmpdir(), NOW).stdout)
  assert.match(text, /on the range the reviewer was given/)
  assert.doesNotMatch(text, /in parallel/)
})

test('craft\'s own agents, a workflow agent and a type that is no project agent: silent and not logged', () => {
  const root = repo()
  for (const type of ['craft:rust-reviewer', 'rust-reviewer', 'workflow-subagent', 'general-purpose', '']) {
    assert.deepEqual(reviewerDispatchHook(call(root, { subagent_type: type }), {}, os.tmpdir(), NOW), { stdout: '', entry: null }, type)
  }
  assert.deepEqual(reviewerDispatchHook(JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'ls' } }), {}, os.tmpdir(), NOW), { stdout: '', entry: null })
  assert.deepEqual(reviewerDispatchHook('not json', {}, root, NOW), { stdout: '', entry: null })
})

test('silences on a project agent are logged with why: not a reviewer, from a subagent, under Codex, switched off', () => {
  const root = repo()
  const dispatch = (/** @type {string} */ type, env = {}, more = {}) => reviewerDispatchHook(call(root, { subagent_type: type }, more), env, os.tmpdir(), NOW)
  /** @param {ReturnType<typeof dispatch>} r */
  const why = r => { assert.equal(r.stdout, ''); assert.equal(r.entry?.spoke, false); assert.equal(r.entry?.reason, REVIEWER_REASON); return r.entry?.silent }
  assert.equal(why(dispatch('designer')), 'not-review')
  assert.equal(why(dispatch('code-checker', {}, { agent_id: 'a1' })), 'in-subagent')
  assert.equal(why(dispatch('code-checker', {}, { turn_id: 't1' })), 'codex')
  assert.equal(why(dispatch('code-checker', { [SWITCH_ENV]: '0' })), 'off-env')
  const off = repo({ 'AGENTS.md': '# Rules\ncraft-role-hook: off\n' })
  assert.equal(why(reviewerDispatchHook(call(off, { subagent_type: 'code-checker' }), {}, os.tmpdir(), NOW)), 'off-line')
})

test('the entry prints the context and appends its log line; silence prints nothing and still logs', async () => {
  const root = repo()
  const home = tmp()
  const spoke = await run([], {}, () => call(root, { subagent_type: 'code-checker', run_in_background: true }), home)
  assert.equal(spoke.exitCode, 0)
  assert.match(said(spoke.stdout[0] ?? ''), /in parallel/)
  const quiet = await run([], { [SWITCH_ENV]: 'off' }, () => call(root, { subagent_type: 'code-checker' }), home)
  assert.deepEqual(quiet, { exitCode: 0, stdout: [], stderr: [] })
  const log = readHookLog(hookLogPath(home)) ?? []
  assert.deepEqual(log.map(e => [e.event, e.reason, e.spoke, e.silent]), [['PreToolUse', REVIEWER_REASON, true, null], ['PreToolUse', REVIEWER_REASON, false, 'off-env']])
  assert.deepEqual(await run([], {}, () => { throw new Error('no stdin') }, home), { exitCode: 0, stdout: [], stderr: [] })
})
