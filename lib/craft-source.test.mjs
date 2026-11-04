// The external-sources CLI (lib/craft-source.mjs, realm @nick/craft, node #430) with git injected: every cache
// lives in a temporary CRAFT_SOURCES_DIR, never under the real ~/.craft, and no test needs the network.
import { test, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeSpec, prepare, run, sourcesRoot } from './craft-source.mjs'
import { gitEnv, STALE_TMP_MS } from './source-checkout.mjs'
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
 * A git that writes what a checkout would: init makes its target, checkout fills `-C`'s (`onClone` sees it filled).
 * ls-remote lists the asked tag unless `tags` says which tags the remote has; `fail` fails every other command.
 * @param {{ fail?: string, onClone?: (target: string) => void, tags?: string[] }} [o]
 */
function fakeGit(o = {}) {
  /** @type {string[][]} */ const calls = []
  /** @param {string} dir */
  const fill = dir => { fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n') }
  /** @param {string} cmd @param {string[]} args */
  const exec = (cmd, args) => {
    calls.push([cmd, ...args])
    if (o.fail && args[0] !== 'ls-remote') throw Object.assign(new Error('Command failed'), { stderr: `fatal: ${o.fail}\n` })
    if (args[0] === 'ls-remote') {
      const asked = String(args.at(-1))
      return (o.tags ?? [asked.replace('refs/tags/', '')]).map(t => `abc123\trefs/tags/${t}`).filter(l => l.endsWith(asked)).join('\n')
    }
    if (args[0] === 'init') fs.mkdirSync(path.join(/** @type {string} */ (args.at(-1)), '.git'), { recursive: true })
    if (args.includes('checkout')) { fill(/** @type {string} */ (args[1])); o.onClone?.(/** @type {string} */ (args[1])) }
    return ''
  }
  return { exec, calls }
}

/** @param {object[]} spec @param {ReturnType<typeof fakeGit>} git @param {string[]} [extra] */
const prep = (spec, git, extra = []) => prepare(['prepare', '--repo-root', repo, '--spec', encodeSpec(/** @type {any} */ (spec)), ...extra], { CRAFT_SOURCES_DIR: cache }, { exec: git.exec })

test('a tag is fetched shallow by its full ref name into <host>/<path>@<ref>, .git dropped, and a second run reuses it', () => {
  const git = fakeGit()
  const first = prep([OVN], git)
  const dir = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@v1.13.2')
  assert.deepEqual(first, { exitCode: 0, answer: { systems: [{ system: 'kube-ovn', ref: 'v1.13.2', dir }] } })
  assert.deepEqual(git.calls[0], ['git', 'ls-remote', '--tags', '--', OVN.repo, 'refs/tags/v1.13.2'])
  assert.match(String(git.calls[1]?.at(-1)), /kube-ovn@v1\.13\.2\.tmp-\d+-[0-9a-f]{8}$/)
  // Only refs/tags/<ref> is ever fetched: a branch of the same name (which `clone --branch` prefers) is never taken.
  assert.deepEqual(git.calls.slice(1).map(c => c.filter(a => !a.includes('.tmp-'))), [
    ['git', 'init', '-q', '--'],
    ['git', '-C', 'fetch', '-q', '--depth', '1', '--', OVN.repo, 'refs/tags/v1.13.2'],
    ['git', '-C', '-c', 'core.symlinks=false', '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'],
  ])
  assert.ok(!git.calls.some(c => c.includes('clone')), 'no clone, so no --branch lookup')
  assert.ok(fs.existsSync(path.join(dir, 'main.go')) && !fs.existsSync(path.join(dir, '.git')))
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['kube-ovn@v1.13.2'], 'no temporary copy is left beside it')
  assert.deepEqual(prep([OVN], git).answer, first.answer)
  assert.equal(git.calls.length, 4, 'the cached copy is reused, git not run again')
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

test('a name the remote lists as no tag — a branch — is refused before anything is cloned', () => {
  const git = fakeGit({ tags: ['v1.13.1', 'v1.13.20'] })
  const { answer } = prep([OVN], git)
  assert.deepEqual(answer.systems, [{ system: 'kube-ovn', error: 'v1.13.2 is not a tag or a commit — a branch would be cached stale' }])
  assert.deepEqual(git.calls.map(c => c[1]), ['ls-remote'])
  assert.ok(!fs.existsSync(path.join(cache, 'github.com')), 'no cache directory made for it')
})

test('a bare version upstream tags with a v is resolved to that tag, cached under it, and reused without git', () => {
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: 1.12.3\n')
  const git = fakeGit({ tags: ['v1.12.3', 'v1.12.30'] })
  const dir = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@v1.12.3')
  assert.deepEqual(prep([OVN], git).answer, { systems: [{ system: 'kube-ovn', ref: 'v1.12.3', dir }] })
  assert.deepEqual(git.calls.slice(0, 2).map(c => c.at(-1)), ['refs/tags/1.12.3', 'refs/tags/v1.12.3'])
  assert.equal(String(git.calls.find(c => c.includes('fetch'))?.at(-1)), 'refs/tags/v1.12.3')
  assert.ok(fs.existsSync(path.join(dir, 'main.go')))
  const before = git.calls.length
  assert.deepEqual(prep([OVN], git).answer, { systems: [{ system: 'kube-ovn', ref: 'v1.12.3', dir }] })
  assert.equal(git.calls.length, before, 'the v copy is reused, git not run again')
})

test('a bare version whose v spelling the remote does not list either is refused, naming both', () => {
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: 1.12.3\n')
  const git = fakeGit({ tags: ['v1.12.4'] })
  assert.deepEqual(prep([OVN], git).answer.systems, [{ system: 'kube-ovn', error: '1.12.3 is not a tag (nor is v1.12.3) or a commit — a branch would be cached stale' }])
  assert.deepEqual(git.calls.map(c => c[1]), ['ls-remote', 'ls-remote'])
})

test('a bare version that is itself a tag is taken as it is, no v spelling asked', () => {
  fs.writeFileSync(path.join(repo, 'chart', 'values.yaml'), 'kubeovn:\n  tag: 1.12.3\n')
  const git = fakeGit({ tags: ['1.12.3', 'v1.12.3'] })
  const dir = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@1.12.3')
  assert.deepEqual(prep([OVN], git).answer.systems, [{ system: 'kube-ovn', ref: '1.12.3', dir }])
  assert.deepEqual(git.calls.filter(c => c[1] === 'ls-remote').map(c => c.at(-1)), ['refs/tags/1.12.3'])
  assert.ok(fs.existsSync(dir))
})

test('a remote that cannot be listed fails the system with git\'s reason', () => {
  const exec = () => { throw Object.assign(new Error('Command failed'), { stderr: 'fatal: could not read Username\n' }) }
  const { answer } = prepare(['prepare', '--repo-root', repo, '--spec', encodeSpec([/** @type {any} */ (OVN)])], { CRAFT_SOURCES_DIR: cache }, { exec })
  assert.deepEqual(answer.systems, [{ system: 'kube-ovn', error: 'git failed: fatal: could not read Username' }])
})

test('temporary copies a dead run left behind are swept once an hour old; a younger one is left to its run', () => {
  const parent = path.join(cache, 'github.com', 'kubeovn')
  fs.mkdirSync(path.join(parent, 'kube-ovn@v1.13.2.tmp-1-dead'), { recursive: true })
  fs.mkdirSync(path.join(parent, 'kube-ovn@v1.13.2.tmp-2-live'), { recursive: true })
  fs.mkdirSync(path.join(parent, 'other@v1.tmp-3-dead'), { recursive: true })
  const old = (Date.now() - STALE_TMP_MS - 60_000) / 1000
  fs.utimesSync(path.join(parent, 'kube-ovn@v1.13.2.tmp-1-dead'), old, old)
  fs.utimesSync(path.join(parent, 'other@v1.tmp-3-dead'), old, old)
  prep([OVN], fakeGit())
  assert.deepEqual(fs.readdirSync(parent).sort(), ['kube-ovn@v1.13.2', 'kube-ovn@v1.13.2.tmp-2-live', 'other@v1.tmp-3-dead'])
})

test('a dead temporary copy is swept when the copy is already cached too, not only before a fetch', () => {
  const parent = path.join(cache, 'github.com', 'kubeovn')
  const git = fakeGit()
  prep([OVN], git)
  const dead = path.join(parent, 'kube-ovn@v1.13.2.tmp-1-dead')
  fs.mkdirSync(dead)
  const old = (Date.now() - STALE_TMP_MS - 60_000) / 1000
  fs.utimesSync(dead, old, old)
  const calls = git.calls.length
  prep([OVN], git)
  assert.equal(git.calls.length, calls, 'the cached copy is reused')
  assert.deepEqual(fs.readdirSync(parent), ['kube-ovn@v1.13.2'])
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

test('a stated version (node #440) is taken as the ref with no file read, its v spelling resolved; a bad one is refused', () => {
  fs.rmSync(path.join(repo, 'chart'), { recursive: true })
  const stated = { system: 'kube-ovn', repo: OVN.repo, versionFrom: '', versionMatch: '', scope: 'src', version: '1.12.3' }
  const dir = path.join(cache, 'github.com', 'kubeovn', 'kube-ovn@v1.12.3')
  assert.deepEqual(prep([stated], fakeGit({ tags: ['v1.12.3'] })).answer.systems, [{ system: 'kube-ovn', ref: 'v1.12.3', dir }])
  const git = fakeGit()
  assert.deepEqual(prep([{ ...stated, version: '-x;rm' }], git).answer.systems, [{ system: 'kube-ovn', error: 'version: revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric' }])
  assert.equal(git.calls.length, 0)
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
  const half = Buffer.from(JSON.stringify([{ system: 's', repo: OVN.repo, versionFrom: 'f', version: 'v1' }])).toString('base64url')
  assert.match(err(['prepare', '--repo-root', repo, '--spec', half]), /versionMatch \| version/, 'half a file and a stated version: refused')
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

test('a spec entry with both a file and a stated version uses the file, as a record does (node #440)', () => {
  const b64 = Buffer.from(JSON.stringify([{ system: 's', repo: 'r', versionFrom: 'f', versionMatch: '(m)', version: 'v1' }, { system: 't', repo: 'r', version: 'v2' }])).toString('base64url')
  assert.deepEqual(decodeSpec(b64), { entries: [{ system: 's', repo: 'r', versionFrom: 'f', versionMatch: '(m)' }, { system: 't', repo: 'r', version: 'v2' }] })
})
