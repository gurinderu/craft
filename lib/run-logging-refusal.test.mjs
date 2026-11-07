// The logger's refusal names which check rejected each candidate (realm @nick/craft, node #382). Executed in
// `sh`, because the reasons are assembled by the shell at run time: the emitted text cannot show them.
import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loggerPrelude } from './run-logging.mjs'

const SCRIPT = 'lib/craft-log-run.mjs'
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'craft-refusal-')))
const home = path.join(tmp, 'home')
const repo = path.join(tmp, 'repo')
fs.mkdirSync(home)
fs.mkdirSync(path.join(repo, 'lib'), { recursive: true })
fs.writeFileSync(path.join(repo, SCRIPT), '// planted\n')
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * Runs the prelude in sh and returns its exit status and output; a line after it proves nothing ran past a refusal.
 * @param {string} prelude @param {Record<string, string>} [env]
 */
function run(prelude, env = {}) {
  const r = spawnSync('sh', ['-c', `${prelude}echo STAGED`], { encoding: 'utf8', cwd: tmp, env: { PATH: process.env['PATH'], HOME: home, ...env } })
  return { status: r.status, out: r.stdout + r.stderr }
}

/** @param {{ status: number | null, out: string }} r @param {string} reasons */
function assertRefused(r, reasons) {
  assert.equal(r.status, 1)
  assert.ok(!r.out.includes('STAGED'), 'the refusal comes before anything after the prelude')
  const lines = r.out.trim().split('\n')
  assert.equal(lines.length, 1, 'the reasons are one line')
  assert.equal(lines[0], `craft-log-run FAILED: no usable logger — ${reasons}refusing to resolve against the reviewed repository`)
}

test('with nothing to try, each source says it had nothing', () => {
  assertRefused(run(loggerPrelude('', '', repo)),
    'craftRoot: not passed; CLAUDE_PLUGIN_ROOT: unset; installed copy: no version to look up; ')
})

test('a relative craftRoot is named as not absolute', () => {
  assertRefused(run(loggerPrelude('.', '', repo)),
    `craftRoot: not absolute (./${SCRIPT}); CLAUDE_PLUGIN_ROOT: unset; installed copy: no version to look up; `)
})

test('an absolute craftRoot with no script is named as a missing file, and so is a missing installed copy', () => {
  const root = path.join(tmp, 'empty-root')
  const cached = path.join(home, '.claude/plugins/cache/craft/craft/1.2.3', SCRIPT)
  assertRefused(run(loggerPrelude(root, '1.2.3', repo)),
    `craftRoot: no file at ${root}/${SCRIPT}; CLAUDE_PLUGIN_ROOT: unset; installed copy 1.2.3: no file at ${cached}; `)
})

test('a craftRoot inside the reviewed repo is named as inside it, with both resolved paths', () => {
  assertRefused(run(loggerPrelude(repo, '', repo)),
    `craftRoot: inside the reviewed repo (${repo}/${SCRIPT} in ${repo}); CLAUDE_PLUGIN_ROOT: unset; installed copy: no version to look up; `)
})

test('a reviewed repo that does not resolve is named as an empty CRAFT_REPO, not as a missing file', () => {
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(path.join(outside, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(outside, SCRIPT), '// a real copy\n')
  const gone = path.join(tmp, 'no-such-repo')
  assertRefused(run(loggerPrelude(outside, '', gone)),
    `craftRoot: the reviewed repo ${gone} did not resolve (CRAFT_REPO empty); CLAUDE_PLUGIN_ROOT: unset; installed copy: no version to look up; `)
})

test('a set CLAUDE_PLUGIN_ROOT naming no script is a missing file; a chain past the hop bound is named as one', () => {
  // A loop fails `[ -f ]` first; only a long chain ending in a real file reaches the bound.
  const chain = path.join(tmp, 'chain')
  fs.mkdirSync(path.join(chain, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(chain, 'lib/end.mjs'), '// end\n')
  let target = path.join(chain, 'lib/end.mjs')
  for (let i = 0; i < 17; i++) {
    const link = path.join(chain, `lib/l${i}.mjs`)
    fs.symlinkSync(target, link)
    target = link
  }
  fs.symlinkSync(target, path.join(chain, SCRIPT))
  const pluginRoot = path.join(tmp, 'plugin-root')
  assertRefused(run(loggerPrelude(chain, '', repo), { CLAUDE_PLUGIN_ROOT: pluginRoot }),
    `craftRoot: a symlink chain over 16 hops; CLAUDE_PLUGIN_ROOT: no file at ${pluginRoot}/${SCRIPT}; installed copy: no version to look up; `)
})

test('a usable candidate after rejected ones still wins, and nothing is printed', () => {
  const good = path.join(tmp, 'good')
  fs.mkdirSync(path.join(good, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(good, SCRIPT), '// a real copy\n')
  const r = run(`${loggerPrelude('.', '', repo)}echo "$CRAFT_LOGGER"\n`, { CLAUDE_PLUGIN_ROOT: good })
  assert.equal(r.status, 0)
  assert.equal(r.out, `${good}/${SCRIPT}\nSTAGED\n`)
})
