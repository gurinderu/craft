// The role hooks in hooks/hooks.json, lib/craft-hook.sh, which runs `craft hook <name>` (realm @nick/craft, nodes #538,
// #550), run as the harness runs them: the command line through `sh -c`, CLAUDE_PLUGIN_ROOT the Claude Code delivery,
// HOME a fresh one, the hook input on stdin, a PATH of the system's tools and this file's shims (no real codex, a curl
// that only records). The binary's own decisions are the CLI's tests' (cli/bin/craft/src/hook/role/, held to
// content/parity/hook-cases.json); this holds what the script does around it and while it is absent, against the same
// cases.
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeExecutable } from './write-executable.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(ROOT, 'lib', 'craft-hook.sh')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.']
const HOOKS = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'claude-code', 'hooks', 'hooks.json'), 'utf8'))
/** @typedef {{ name: string, command: string, input: unknown, env?: Record<string, string>, files?: Record<string, string>, links?: Record<string, string>, dirs?: string[], cwd?: string, git?: boolean, probe?: unknown, stdout: string, entryLine: string | null }} Case */
/** @type {{ cases: Case[], opencode: Case[] }} */
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'parity', 'hook-cases.json'), 'utf8'))
const EVENTS = /** @type {const} */ ([
  ['SessionStart', 'session-start'],
  ['UserPromptSubmit', 'user-prompt'],
  ['SubagentStart', 'subagent-start'],
  ['PreToolUse', 'reviewer-dispatch'],
])

/** The command each hooks.json entry that runs the script gives, by event. @returns {Map<string, { command: string, timeout: number }>} */
function commands() {
  /** @type {Record<string, { matcher?: string, hooks: { command: string, timeout: number }[] }[]>} */
  const all = HOOKS.hooks
  return new Map(
    Object.entries(all).flatMap(([event, groups]) => groups.flatMap(g => g.hooks.filter(h => h.command.includes('lib/craft-hook.sh')).map(h => [event, h]))),
  )
}

let HOME = ''
let SHIM = ''
let REPO = ''
beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-home-'))
  SHIM = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-shim-'))
  REPO = repo({ '.claude/agents/dev.md': '' })
  writeExecutable(path.join(SHIM, 'curl'), `#!/bin/sh\necho "$*" >> '${SHIM}/curl-hits'\nexit 22\n`)
})

/** A throwaway repo with `files`. @param {Record<string, string>} files @param {boolean} [git] */
function repo(files, git = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-repo-')))
  if (git) fs.mkdirSync(path.join(root, '.git'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

/**
 * One hook run as the harness runs it. @param {string} event @param {{ env?: Record<string, string>, input?: string, cwd?: string }} [o]
 */
function run(event, o = {}) {
  const hook = commands().get(event)
  assert.ok(hook, event)
  const env = {
    PATH: `${SHIM}:/usr/bin:/bin`,
    HOME,
    CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'integrations', 'claude-code'),
    CRAFT_RELEASE_BASE: 'file:///nonexistent',
    ...o.env,
  }
  const input = o.input ?? JSON.stringify({ hook_event_name: event, cwd: REPO, session_id: 's1' })
  const began = Date.now()
  const r = spawnSync('sh', ['-c', hook.command], { input, env, encoding: 'utf8', cwd: o.cwd ?? REPO })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - began }
}

/** The binary of this version in the cache, a script with `body`. @param {string} body */
function cache(body) {
  const dir = path.join(HOME, '.craft', 'bin', VERSION)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'craft'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** @param {string} stdout @returns {{ systemMessage?: string, hookSpecificOutput?: { hookEventName: string, additionalContext: string } }} */
const parsed = stdout => JSON.parse(stdout)

/** Wait up to 5 s for `file`. @param {string} file */
function waitFor(file) {
  const until = Date.now() + 5000
  while (!fs.existsSync(file) && Date.now() < until) spawnSync('sleep', ['0.1'])
  return fs.existsSync(file)
}

test('the four role hooks each run the script with their own hook name, bounded at 10 s', () => {
  const all = commands()
  assert.deepEqual([...all.keys()].sort(), EVENTS.map(([e]) => e).sort())
  for (const [event, name] of EVENTS) {
    assert.equal(all.get(event)?.command, `sh "\${CLAUDE_PLUGIN_ROOT}/lib/craft-hook.sh" ${name} || true`)
    assert.equal(all.get(event)?.timeout, 10)
  }
})

test('with no binary, a repo with role signs: the start returns at once, starts the download in the background and tells the human (realm #550)', () => {
  const start = run('SessionStart')
  assert.equal(start.code, 0)
  assert.ok(start.ms < 2000, `${start.ms} ms`)
  assert.equal(
    parsed(start.stdout).systemMessage,
    `craft: the session-start hook did not run: the craft binary ${VERSION} is not on this machine yet (${HOME}/.craft/bin/${VERSION}/craft); it is being downloaded in the background (~/.craft/bin/${VERSION}.log), and craft's hooks speak once it is there.`,
  )
  assert.ok(waitFor(path.join(SHIM, 'curl-hits')), 'the download started')
  assert.match(fs.readFileSync(path.join(SHIM, 'curl-hits'), 'utf8'), new RegExp(`file:///nonexistent/craft-[\\w-]+\\.tar\\.gz`))
  for (const [event, name] of EVENTS.slice(1)) {
    const r = run(event)
    assert.deepEqual([r.code, r.stdout], [0, ''], event)
    assert.match(r.stderr, new RegExp(`^craft: the ${name} hook did not run: the craft binary .* is not on this machine yet`), event)
  }
})

test('with no binary, no role signs or the switch off: silence, and nothing downloaded', () => {
  const bare = repo({ 'AGENTS.md': '# Build\nnpm test\n' })
  const off = repo({ '.claude/agents/dev.md': '', 'CLAUDE.md': 'x\r\n  craft-role-hook: OFF\r\n' })
  const runs = [
    run('SessionStart', { input: JSON.stringify({ cwd: bare }) }),
    run('SessionStart', { input: JSON.stringify({ cwd: off }) }),
    run('SessionStart', { env: { CRAFT_ROLE_HOOK: ' Off ' } }),
    ...EVENTS.slice(1).map(([event]) => run(event, { input: JSON.stringify({ cwd: bare }) })),
  ]
  for (const r of runs) assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
  spawnSync('sleep', ['0.5'])
  assert.equal(fs.existsSync(path.join(SHIM, 'curl-hits')), false)
})

/** The case's repo, as the parity test lays it out. @param {Case} c */
function layOut(c) {
  const root = repo(c.files ?? {}, c.git !== false)
  for (const [rel, target] of Object.entries(c.links ?? {})) fs.symlinkSync(target.split('<root>').join(root), path.join(root, rel))
  for (const d of c.dirs ?? []) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

/** A case run with no binary cached; `codex` the fake codex's script, if any. @param {Case} c @param {string} [codex] */
function absentRun(c, codex) {
  const root = layOut(c)
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-plugin-'))
  /** @param {string} s */
  const fill = s => s.split('<root>').join(root).split('<plugin>').join(plugin).split('<home>').join(HOME)
  const input = typeof c.input === 'string' ? fill(c.input) : fill(JSON.stringify(c.input))
  const env = Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, fill(v)]))
  fs.rmSync(path.join(SHIM, 'codex'), { force: true })
  if (codex) writeExecutable(path.join(SHIM, 'codex'), codex)
  // A fresh HOME per case: an attempt in one would hold the next one's download back.
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-hook-home-'))
  return run('SessionStart', { input, env, cwd: path.join(root, c.cwd ?? '') })
}

const starts = GOLDEN.cases.filter(c => c.command === 'session-start')

test("while the binary is absent, the script's repo test speaks exactly where the binary's does (content/parity/hook-cases.json)", () => {
  assert.ok(starts.length > 25)
  for (const c of starts) {
    const found = /** @type {{ found: string[] }} */ (JSON.parse(c.entryLine ?? '{}')).found
    const got = absentRun(c, '#!/bin/sh\nexit 0\n')
    assert.equal(got.code, 0, c.name)
    assert.equal(got.stdout === '' ? undefined : parsed(got.stdout).systemMessage !== undefined, found.length > 0 ? true : undefined, c.name)
  }
})

test("the script's repo test finds exactly what the binary's does, in every case of content/parity/hook-cases.json (realm #550)", () => {
  const cases = [...GOLDEN.cases, ...GOLDEN.opencode].filter(c => c.entryLine && c.command !== 'opencode-compacted')
  assert.ok(cases.length > 90, String(cases.length))
  for (const c of cases) {
    const entry = /** @type {{ found: string[], harness: string }} */ (JSON.parse(c.entryLine ?? '{}'))
    const root = layOut(c)
    const r = spawnSync('sh', [path.join(ROOT, 'lib', 'craft-hook-repo.sh'), 'found', path.join(root, c.cwd ?? ''), entry.harness], {
      env: { PATH: '/usr/bin:/bin', ...(c.env ?? {}) },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, c.name)
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), entry.found, c.name)
  }
})

test("under Codex, while the binary is absent, the start says the binary's own sandbox line, and honours the switch", () => {
  const codex = starts.filter(c => c.probe !== undefined)
  assert.ok(codex.length >= 6)
  for (const c of codex) {
    const p = /** @type {{ status: number | null, stderr: string } | string} */ (c.probe)
    // A probe that timed out the fake outlives the script's bound; a missing codex is no fake at all.
    const fake =
      typeof p === 'string'
        ? undefined
        : p.status === null
          ? '#!/bin/sh\nsleep 5\n'
          : `#!/bin/sh\nprintf '%s' '${p.stderr.replace(/'/g, "'\\''")}' >&2\nexit ${p.status}\n`
    const want = (c.stdout ? (parsed(c.stdout).hookSpecificOutput?.additionalContext ?? '') : '')
      .split('\n')
      .filter(l => l.startsWith('craft: before any work'))
    const got = absentRun(c, fake)
    const said = got.stdout ? parsed(got.stdout).hookSpecificOutput?.additionalContext : undefined
    assert.deepEqual(said === undefined ? [] : [said], want, c.name)
  }
})

test("the cached binary of this version gets the input and its hook name, its output is the hook's", () => {
  cache('cat > "$HOME/input"; printf "%s\\n" "$*"; echo noise >&2')
  for (const [event, name] of EVENTS) {
    assert.deepEqual([run(event).stdout, run(event).stderr], [`hook ${name}\n`, ''], event)
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'input'), 'utf8')).session_id, 's1', event)
  }
  cache('exit 0')
  assert.deepEqual(run('UserPromptSubmit').stdout, '', 'silence stays silence')
})

test('a binary that fails is said to the human once per session, then on stderr (realm #550)', () => {
  cache('echo partial; exit 126')
  const first = run('UserPromptSubmit')
  assert.equal(parsed(first.stdout).systemMessage, `craft: the user-prompt hook did not run: the craft binary ${VERSION} failed (exit 126).`)
  const again = run('SessionStart')
  assert.deepEqual([again.code, again.stdout], [0, ''])
  assert.match(again.stderr, /^craft: the session-start hook did not run: the craft binary .* failed \(exit 126\)\.\n$/)
  const other = run('SubagentStart', { input: JSON.stringify({ cwd: REPO, session_id: 's/2' }) })
  assert.match(String(parsed(other.stdout).systemMessage), /subagent-start hook did not run/)
  assert.deepEqual(fs.readdirSync(path.join(HOME, '.craft', 'hook-failed')).sort(), ['s1', 's_2'])
})

test('CRAFT_BIN runs a local build and downloads nothing; a path with a quote is escaped in the notice', () => {
  const local = path.join(HOME, 'my"craft')
  assert.match(String(parsed(run('SessionStart', { env: { CRAFT_BIN: local } }).stdout).systemMessage), /not on this machine yet \(.*my\\?"craft\)\.$/)
  spawnSync('sleep', ['0.3'])
  assert.equal(fs.existsSync(path.join(SHIM, 'curl-hits')), false)
  fs.writeFileSync(local, '#!/bin/sh\nprintf local\n', { mode: 0o755 })
  assert.equal(run('SessionStart', { env: { CRAFT_BIN: local } }).stdout, 'local\n')
})

test('an unknown hook name says so on stderr and exits 0', () => {
  const r = spawnSync('sh', [SCRIPT, 'nope'], { input: '{}', env: { PATH: '/usr/bin:/bin', HOME }, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', 'craft: no craft hook named "nope".\n'])
})

test('it carries the plugin version on the line release-please moves', () => {
  const lines = fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter(l => l.includes('x-release-please-version'))
  assert.deepEqual(lines, [`version=${VERSION} # x-release-please-version`])
  const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8')).packages['.']['extra-files']
  assert.ok(extra.some((/** @type {{ type: string, path: string }} */ f) => f.type === 'generic' && f.path === 'lib/craft-hook.sh'))
})

const bin = (/** @type {string} */ f) => path.join(HOME, '.craft', 'bin', f)
/** Set `file`'s times `minutes` back. @param {string} file @param {number} minutes */
const age = (file, minutes) => {
  const t = new Date(Date.now() - minutes * 60 * 1000)
  fs.utimesSync(file, t, t)
}
const curlHits = () => (fs.existsSync(path.join(SHIM, 'curl-hits')) ? fs.readFileSync(path.join(SHIM, 'curl-hits'), 'utf8').trim().split('\n').length : 0)

test('the download is tried at most once an hour; a failed one is said once, then the hooks stay silent (realm #550)', () => {
  const first = run('SessionStart')
  assert.match(String(parsed(first.stdout).systemMessage), /being downloaded in the background/)
  assert.ok(waitFor(bin(`${VERSION}.status`)), 'the attempt ended and said how')
  const hits = curlHits()
  const failed = run('SessionStart')
  assert.equal(
    parsed(failed.stdout).systemMessage,
    `craft: the session-start hook did not run: the craft binary ${VERSION} could not be downloaded (see ~/.craft/bin/${VERSION}.log); craft's hooks stay silent until it is there.`,
  )
  assert.deepEqual([run('SessionStart').stdout, run('SessionStart').stderr], ['', ''], 'said once')
  spawnSync('sleep', ['0.3'])
  assert.equal(curlHits(), hits, 'no new attempt within the hour')
  age(bin(`${VERSION}.attempt`), 61)
  // One failing streak, one line: the hourly retry is silent, and so is its failure.
  assert.deepEqual([run('SessionStart').stdout, run('UserPromptSubmit').stdout], ['', ''], 'after an hour, tried again in silence')
  const until = Date.now() + 5000
  while (curlHits() <= hits && Date.now() < until) spawnSync('sleep', ['0.1'])
  assert.ok(curlHits() > hits, 'tried again')
  spawnSync('sleep', ['0.5'])
  assert.deepEqual([run('SessionStart').stdout, run('SessionStart').stderr], ['', ''], 'the failure is not said again')
})

test('a failure marker that cannot be pruned does not keep the notice coming (the marker is written regardless)', () => {
  cache('exit 3')
  const stuck = path.join(HOME, '.craft', 'hook-failed', 'stuck')
  fs.mkdirSync(stuck, { recursive: true })
  fs.writeFileSync(path.join(stuck, 'old'), '')
  age(path.join(stuck, 'old'), 2 * 24 * 60)
  fs.chmodSync(stuck, 0o555)
  try {
    assert.match(String(parsed(run('UserPromptSubmit').stdout).systemMessage), /failed \(exit 3\)/)
    const again = run('UserPromptSubmit')
    assert.equal(again.stdout, '', 'said once')
    assert.match(again.stderr, /failed \(exit 3\)/)
  } finally {
    fs.chmodSync(stuck, 0o755)
  }
})

test('the download log is cut back past 64 KiB before it is written again', () => {
  fs.mkdirSync(bin(''), { recursive: true })
  fs.writeFileSync(bin(`${VERSION}.log`), 'x'.repeat(70 * 1024))
  run('SessionStart')
  assert.ok(waitFor(bin(`${VERSION}.status`)))
  assert.ok(fs.statSync(bin(`${VERSION}.log`)).size < 4096)
})

test('a failure marker older than a day is pruned when the next one is written', () => {
  cache('exit 3')
  const dir = path.join(HOME, '.craft', 'hook-failed')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'old'), '')
  age(path.join(dir, 'old'), 2 * 24 * 60)
  fs.writeFileSync(path.join(dir, 'recent'), '')
  run('UserPromptSubmit')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['recent', 's1'])
})

test('the Codex sandbox probe past its bound is killed with every process it started', () => {
  const pids = path.join(SHIM, 'pids')
  const c = /** @type {Case} */ ({
    name: 'probe',
    command: 'session-start',
    input: { cwd: '<root>' },
    env: { PLUGIN_ROOT: '<plugin>' },
    stdout: '',
    entryLine: null,
  })
  const got = absentRun(c, `#!/bin/sh\nsleep 30 &\necho $! >> '${pids}'\nsleep 30\n`)
  assert.equal(got.code, 0)
  spawnSync('sleep', ['0.3'])
  const child = Number(fs.readFileSync(pids, 'utf8').trim())
  assert.equal(spawnSync('kill', ['-0', String(child)]).status, 1, 'the grandchild is gone too')
})
