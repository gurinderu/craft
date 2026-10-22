import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hookLogPath, readHookLog } from './hook-log.mjs'
import { PUSH_REASON, hasVerdict, pushHook, pushText } from './push-hook.mjs'
import { run } from './push-hook-entry.mjs'
import { SWITCH_ENV } from './role-hook.mjs'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'push-hook-entry.mjs')
const NOW = new Date('2026-10-22T12:00:00Z')
/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @returns {string} */
function tmp() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-push-hook-')))
  made.push(dir)
  return dir
}

/** @param {string[]} args @param {string} cwd @returns {string | null} */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * A clone with a declared role (unless `declared` is false) on branch feat/x, pushed once, then one commit ahead.
 * @param {boolean} [declared] @returns {{ root: string, head: string }}
 */
function clone(declared = true) {
  const base = tmp()
  git(['init', '-q', '--bare', '-b', 'main', 'remote.git'], base)
  const root = path.join(base, 'work')
  git(['clone', '-q', path.join(base, 'remote.git'), root], base)
  if (declared) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'dev.md'), '')
  }
  git(['commit', '-q', '--allow-empty', '-m', 'a'], root)
  git(['push', '-q', 'origin', 'HEAD:main'], root)
  git(['switch', '-q', '-c', 'feat/x'], root)
  git(['commit', '-q', '--allow-empty', '-m', 'b'], root)
  git(['push', '-q', '-u', 'origin', 'feat/x'], root)
  git(['commit', '-q', '--allow-empty', '-m', 'fix'], root)
  return { root, head: git(['rev-parse', 'HEAD'], root) ?? '' }
}

/** @param {string} root @param {string} command @param {Record<string, unknown>} [more] */
const input = (root, command, more = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, session_id: 's', tool_input: { command }, ...more })

/** @param {string} head @param {string} project @param {Record<string, unknown>} [more] */
const record = (head, project, more = {}) => ({ kind: 'workflow', name: 'review', project, reviewedHead: head, reviewedDirty: false, nested: false, verdict: 'Approve', ...more })

test('a push to a branch under review whose head has no verdict gets one line; with a verdict on that head it is silent', () => {
  const { root, head } = clone()
  const said = pushHook(input(root, 'git push'), {}, root, NOW, { git, index: () => [] })
  assert.deepEqual(JSON.parse(said.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', additionalContext: pushText(head) })
  assert.equal(pushText(head), `craft: this push had no complete craft verdict on ${head.slice(0, 8)}; review the pushed fix commits (a light re-review, craft:review) before replying or requesting review.`)
  assert.deepEqual([said.entry?.spoke, said.entry?.reason, said.entry?.event, said.entry?.repo], [true, PUSH_REASON, 'PreToolUse', root])
  const reviewed = pushHook(input(root, 'rtk git push'), {}, root, NOW, { git, index: () => [record(head, root)] })
  assert.deepEqual([reviewed.stdout, reviewed.entry?.silent], ['', 'verdict'])
  const other = pushHook(input(root, 'git push origin HEAD:feat/x'), {}, root, NOW, { git, index: () => [record(head, '/elsewhere')] })
  assert.equal(other.entry?.reason, PUSH_REASON, 'a verdict of another project does not count')
})

test('a push to trunk, a first push, an up-to-date push and a tags push are silent, each logged with why', () => {
  const { root, head } = clone()
  /** @param {string} command @param {string} [cwd] */
  const why = (command, cwd = root) => { const r = pushHook(input(cwd, command), {}, cwd, NOW, { git, index: () => [] }); return [r.stdout, r.entry?.silent] }
  assert.deepEqual(why('git push origin HEAD:main'), ['', 'trunk'])
  assert.deepEqual(why('git push origin HEAD:refs/heads/master'), ['', 'trunk'])
  assert.deepEqual(why('git push -u origin HEAD:feat/new'), ['', 'no-remote-branch'])
  assert.deepEqual(why('git push origin feat/x~1:feat/x'), ['', 'up-to-date'])
  assert.deepEqual(why('git push --tags'), ['', 'tags'])
  assert.deepEqual(why('git push origin :feat/x'), ['', 'delete'])
  const moved = pushHook(input('/', `cd ${root} && git push`), {}, '/', NOW, { git, index: () => [] })
  assert.equal(moved.entry?.reason, PUSH_REASON, 'a cd before the push moves where it is judged')
  const sub = pushHook(input('/', `(cd ${root} && git push --prune origin HEAD:feat/x)`), {}, '/', NOW, { git, index: () => [] })
  assert.equal(sub.entry?.reason, PUSH_REASON, 'a subshell cd, and --prune beside a refspec, still judge the push')
  const dirty = pushHook(input(root, 'git push'), {}, root, NOW, { git, index: () => [record(head, root, { reviewedDirty: true })] })
  assert.equal(dirty.entry?.reason, PUSH_REASON, 'a dirty-tree review is no verdict on the commit')
})

test('a push with a redirection is judged; a branch whose upstream has another name follows push.default', () => {
  const { root } = clone()
  const run = (/** @type {string} */ command) => pushHook(input(root, command), {}, root, NOW, { git, index: () => [] }).entry
  assert.equal(run('git push 2>&1 | tail -3')?.reason, PUSH_REASON)
  git(['switch', '-q', '-c', 'local', '--track', 'origin/feat/x'], root)
  git(['commit', '-q', '--allow-empty', '-m', 'fix2'], root)
  git(['config', 'push.default', 'simple'], root)
  assert.equal(run('git push origin 2>&1')?.silent, 'refused','simple (the default) refuses a push to an upstream of another name')
  git(['config', 'push.default', 'upstream'], root)
  assert.equal(run('git push origin 2>&1')?.reason, PUSH_REASON, 'upstream: local goes to feat/x, which is tracked')
  git(['config', 'push.default', 'current'], root)
  assert.equal(run('git push')?.silent, 'no-remote-branch', 'current: local goes to local, never pushed')
  assert.equal(run('git push origin HEAD:local')?.silent, 'no-remote-branch', 'a named refspec is taken as written')
})

test('the off switch, a repo that declares nothing and a command with no push stay silent', () => {
  const { root } = clone()
  const off = pushHook(input(root, 'git push'), { [SWITCH_ENV]: '0' }, root, NOW, { git, index: () => [] })
  assert.deepEqual([off.stdout, off.entry?.silent], ['', 'off-env'])
  const bare = clone(false)
  const quiet = pushHook(input(bare.root, 'git push'), {}, bare.root, NOW, { git, index: () => [] })
  assert.deepEqual([quiet.stdout, quiet.entry?.silent], ['', 'nothing-declared'])
  for (const command of ['git status', 'git commit -m push', 'ls']) assert.deepEqual(pushHook(input(root, command), {}, root, NOW, { git, index: () => [] }), { stdout: '', entry: null })
})

test('a verdict is a top-level, complete review of the project at the pushed head', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01'
  assert.ok(hasVerdict([record(sha, '/p')], '/p', sha))
  assert.ok(hasVerdict([record('abcdef01', '/p', { verdict: 'Block' })], '/p', sha))
  assert.ok(!hasVerdict([record(sha, '/p', { name: 'adversarial-review' })], '/p', sha), 'adversarial-review files no reviewed head of its own')
  assert.ok(hasVerdict([record(sha, '/p', { dirty: true })], '/p', sha), 'write-time dirtiness (untracked files too) is not what the run read')
  assert.ok(hasVerdict([record(sha, '/p', { verdict: 'Approve (PARTIAL COVERAGE)' })], '/p', sha), 'a coverage hole a re-run will not fix is still a verdict')
  for (const more of [{ reviewedDirty: true }, { verdict: 'INCOMPLETE (empty diff)' }, { verdict: 'INCOMPLETE' }, { verdict: 'Block (INCOMPLETE)' }, { verdict: 'Warning (INCOMPLETE)' }, { verdict: 'Approve (candidates)' }, { verdict: 'INCOMPLETE (candidates)' }, { verdict: null }, { nested: true },{ name: 'rust-audit' }, { kind: 'agent' }, { reviewedHead: 'abc' }, { reviewedHead: null, head: sha }, { reviewedDirty: null }]) {
    assert.ok(!hasVerdict([record(sha, '/p', more)], '/p', sha), JSON.stringify(more))
  }
  assert.match(pushText(sha, 'codex'), /review the pushed fix commits yourself .* before replying or requesting review\.$/)
})

test('every error is silence: bad input, git that fails, a store that throws, a directory that is gone', async () => {
  const { root } = clone()
  const failing = { git: () => null, index: () => [] }
  assert.deepEqual(pushHook('not json', {}, root, NOW, failing), { stdout: '', entry: null })
  assert.equal(pushHook(input(root, 'git push'), {}, root, NOW, failing).entry?.silent, 'detached')
  const home = tmp()
  const thrown = await run([], {}, () => { throw new Error('no stdin') }, home)
  assert.deepEqual(thrown, { exitCode: 0, stdout: [], stderr: [] })
  const gone = await run([], {}, () => input(path.join(root, 'nope'), 'git push origin HEAD:feat/x'), home)
  assert.deepEqual([gone.exitCode, gone.stdout], [0, []])
})

test('the entry, run as the harness runs it, prints the line and logs it under ~/.craft/hooks.jsonl', () => {
  const { root, head } = clone()
  const home = tmp()
  const r = spawnSync(process.execPath, [HOOK], { input: input(root, 'git -C . push'), cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).systemMessage, pushText(head))
  assert.deepEqual(readHookLog(hookLogPath(home))?.map(e => [e.event, e.reason]), [['PreToolUse', PUSH_REASON]])
})
