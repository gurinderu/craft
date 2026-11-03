// The external-sources CLI (lib/craft-source.mjs, realm @nick/craft, node #430) with git injected: every cache
// lives in a temporary CRAFT_SOURCES_DIR, never under the real ~/.craft, and no test needs the network.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepare, run, sourcesRoot, gitEnv } from './craft-source.mjs'
import { encodeSpec } from './external-source-spec.mjs'

/** @type {string} */ let tmp
/** @type {string} */ let repo
/** @type {string} */ let cache
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-source-')))
  repo = path.join(tmp, 'repo')
  cache = path.join(tmp, 'cache')
  fs.mkdirSync(path.join(repo, 'chart'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: v1.13.2\nkubevirt: 0123456789abcdef0123456789abcdef01234567\n')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const OVN = { system: 'kube-ovn', repo: 'https://github.com/kubeovn/kube-ovn.git', versionFrom: 'chart/values.yaml', versionMatch: 'tag: (\\S+)', scope: 'src' }
const VIRT = { system: 'kubevirt', repo: 'git@github.com:kubevirt/kubevirt.git', versionFrom: 'chart/values.yaml', versionMatch: '^kubevirt: ([0-9a-f]+)$', scope: 'src' }

/**
 * A git that writes what a checkout would: clone fills its target, init makes one, checkout fills `-C`'s.
 * @param {{ fail?: string, onClone?: (target: string) => void }} [o]
 */
function fakeGit(o = {}) {
  /** @type {string[][]} */ const calls = []
  /** @param {string} dir */
  const fill = dir => { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n') }
  /** @param {string} cmd @param {string[]} args */
  const exec = (cmd, args) => {
    calls.push([cmd, ...args])
    if (o.fail) throw Object.assign(new Error('Command failed'), { stderr: `fatal: ${o.fail}\n` })
    if (args[0] === 'clone') { fill(/** @type {string} */ (args.at(-1))); o.onClone?.(/** @type {string} */ (args.at(-1))) }
    if (args[0] === 'init') fs.mkdirSync(path.join(/** @type {string} */ (args.at(-1)), '.git'), { recursive: true })
    if (args.includes('checkout')) fill(/** @type {string} */ (args[1]))
  }
  return { exec, calls }
}

/** @param {object[]} spec @param {ReturnType<typeof fakeGit>} git @param {string[]} [extra] */
const prep = (spec, git, extra = []) => prepare(['prepare', '--repo-root', repo, '--spec', encodeSpec(/** @type {any} */ (spec)), ...extra], { CRAFT_SOURCES_DIR: cache }, { exec: git.exec })

test('a tag is cloned shallow by name into <host>/<path>@<ref>, .git dropped, and a second run reuses it', () => {
  const git = fakeGit()
  const first = prep([OVN], git)
  const dir = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@v1.13.2')
  assert.deepEqual(first, { exitCode: 0, answer: { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir }] } })
  assert.equal(git.calls.length, 1)
  const [cmd, ...args] = /** @type {string[]} */ (git.calls[0])
  assert.equal(cmd, 'git')
  assert.deepEqual(args.slice(0, -1), ['clone', '-q', '--depth', '1', '--config', 'core.symlinks=false', '--branch', 'v1.13.2', '--', OVN.repo])
  assert.match(String(args.at(-1)), /kube-ovn@v1\.13\.2\.tmp-\d+-[0-9a-f]{8}$/)
  assert.ok(fs.existsSync(path.join(dir, 'main.go')) && !fs.existsSync(path.join(dir, '.git')))
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['kube-ovn@v1.13.2'], 'no temporary copy is left beside it')
  assert.deepEqual(prep([OVN], git).answer, first.answer)
  assert.equal(git.calls.length, 1, 'the cached copy is reused, git not run again')
})

test('a full commit id is fetched by sha into a fresh repository and checked out detached', () => {
  const git = fakeGit()
  const { answer } = prep([VIRT], git)
  const sha = '0123456789abcdef0123456789abcdef01234567'
  assert.deepEqual(answer.systems, [{ system: 'kubevirt', ref: sha, dir: path.join(cache, 'github.com', 'kubevirt', `kubevirt@${sha}`) }])
  assert.deepEqual(git.calls.map(c => c.filter(a => !a.includes('.tmp-'))), [
    ['git', 'init', '-q', '--'],
    ['git', '-C', 'fetch', '-q', '--depth', '1', '--', VIRT.repo, sha],
    ['git', '-C', '-c', 'core.symlinks=false', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'],
  ])
})

test('a rename that loses the race drops its own copy and takes the one already in place', () => {
  const winner = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@v1.13.2')
  const git = fakeGit({ onClone: () => { fs.mkdirSync(winner, { recursive: true }); fs.writeFileSync(path.join(winner, 'WINNER'), '') } })
  const { answer } = prep([OVN], git)
  assert.deepEqual(answer.systems, [{ system: 'kube-ovn', ref: 'v1.13.2', dir: winner }])
  assert.deepEqual(fs.readdirSync(winner), ['WINNER'])
  assert.deepEqual(fs.readdirSync(path.dirname(winner)), ['kube-ovn@v1.13.2'])
})

test('each system fails on its own, with its reason, and the run still exits 0', () => {
  const bad = [
    { ...OVN, system: 'bad name!' },
    { ...OVN, system: 'opt', repo: '--upload-pack=evil' },
    { ...OVN, system: 'file', repo: 'file:///etc' },
    { ...OVN, system: 'dots', repo: 'https://github.com/../etc' },
    { ...OVN, system: 'outside', versionFrom: '../../etc/passwd' },
    { ...OVN, system: 'missing', versionFrom: 'chart/nope.yaml' },
    { ...OVN, system: 'nomatch', versionMatch: 'image: (\\S+)' },
    { ...OVN, system: 'twogroups', versionMatch: '(tag): (\\S+)' },
    { ...OVN, system: 'nogroup', versionMatch: 'tag: \\S+' },
    { ...OVN, system: 'broken', versionMatch: 'tag: (' },
  ]
  const git = fakeGit()
  const first = prep(bad.slice(0, 5), git)
  const rest = prep(bad.slice(5), git)
  assert.equal(first.exitCode, 0)
  const errors = [...(first.answer.systems ?? []), ...(rest.answer.systems ?? [])].map(s => ('error' in s ? `${s.system}: ${s.error}` : `${s.system}: ok`))
  assert.deepEqual(errors.map(e => e.replace(/ .*/, '')), ['bad', 'opt:', 'file:', 'dots:', 'outside:', 'missing:', 'nomatch:', 'twogroups:', 'nogroup:', 'broken:'])
  for (const [i, re] of /** @type {Array<[number, RegExp]>} */ ([[0, /system is not a name/], [1, /starts with "-"/], [2, /not an https:\/\/, ssh:\/\/ or git@host:path URL/], [3, /"\.\." segment/], [4, /outside the repository/], [5, /not found/], [6, /found no version/], [7, /2 capture groups/], [8, /0 capture groups/], [9, /does not compile/]])) {
    assert.match(String(errors[i]), re)
  }
  assert.equal(git.calls.length, 0, 'nothing was fetched for a refused system')
})

test('a symlinked version file that leads out of the repository is refused', () => {
  fs.writeFileSync(path.join(tmp, 'outside.yaml'), 'tag: v1\n')
  fs.symlinkSync(path.join(tmp, 'outside.yaml'), path.join(repo, 'chart', 'link.yaml'))
  const { answer } = prep([{ ...OVN, versionFrom: 'chart/link.yaml' }], fakeGit())
  assert.deepEqual(answer.systems, [{ system: 'kube-ovn', error: 'versionFrom resolves outside the repository' }])
})

test('a revision outside the safe charset is refused before any git runs', () => {
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'tag: -v1;rm\n')
  const git = fakeGit()
  const { answer } = prep([OVN], git)
  assert.match(String(answer.systems?.[0] && 'error' in answer.systems[0] ? answer.systems[0].error : ''), /revision outside/)
  assert.equal(git.calls.length, 0)
})

test('a git failure is the system\'s error, its stderr line kept, and no partial copy is left', () => {
  const { answer } = prep([OVN], fakeGit({ fail: 'Remote branch v1.13.2 not found in upstream origin' }))
  assert.deepEqual(answer.systems, [{ system: 'kube-ovn', error: 'git failed: fatal: Remote branch v1.13.2 not found in upstream origin' }])
  assert.deepEqual(fs.readdirSync(path.join(cache, 'github.com', 'kubeovn')), [])
})

test('a malformed invocation is one error and exit 1', () => {
  const git = fakeGit()
  const spec = encodeSpec([/** @type {any} */ (OVN)])
  /** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] */
  const err = (argv, env = { CRAFT_SOURCES_DIR: cache }) => {
    const r = prepare(argv, env, { exec: git.exec })
    assert.equal(r.exitCode, 1)
    return String(r.answer.error)
  }
  assert.match(err(['fetch', '--repo-root', repo, '--spec', spec]), /usage/)
  assert.match(err(['prepare', '--repo-root', repo, '--spec', spec, '--upload-pack', 'x']), /usage/)
  assert.match(err(['prepare', '--repo-root', repo, '--depth', spec]), /unexpected option/)
  assert.match(err(['prepare', '--repo-root', 'rel', '--spec', spec]), /not an absolute path/)
  assert.match(err(['prepare', '--repo-root', repo, '--spec', 'a b']), /not base64url/)
  assert.match(err(['prepare', '--repo-root', repo, '--spec', Buffer.from('[]').toString('base64url')]), /not a list of 1\.\.8/)
  assert.match(err(['prepare', '--repo-root', repo, '--spec', Buffer.from('{').toString('base64url')]), /not base64url JSON/)
  assert.match(err(['prepare', '--spec', spec, '--repo-root', path.join(tmp, 'gone')]), /does not exist/)
  assert.match(err(['prepare', '--repo-root', repo, '--spec', spec], { CRAFT_SOURCES_DIR: 'relative' }), /not absolute/)
  assert.equal(git.calls.length, 0)
})

test('run prints the answer as one JSON line', async () => {
  const r = await run(['prepare'], { CRAFT_SOURCES_DIR: cache })
  assert.equal(r.exitCode, 1)
  assert.deepEqual(r.stdout.map(l => Object.keys(JSON.parse(l))), [['error']])
})

test('the cache defaults to ~/.craft/sources, and git never prompts', () => {
  assert.deepEqual(sourcesRoot({ HOME: '/home/x' }), { root: '/home/x/.craft/sources' })
  assert.deepEqual(sourcesRoot({ CRAFT_SOURCES_DIR: '/c', HOME: '/home/x' }), { root: '/c' })
  assert.deepEqual([gitEnv({}).GIT_TERMINAL_PROMPT, gitEnv({}).GIT_SSH_COMMAND], ['0', 'ssh -o BatchMode=yes'])
  assert.equal(gitEnv({ GIT_SSH_COMMAND: 'mine' }).GIT_SSH_COMMAND, 'mine')
})
