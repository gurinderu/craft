// craft:adversarial-review's verdict keyed to the commit it read: the engine runs in the harness, and each logger
// dispatch it makes (the start checkpoint, the record) is carried out by the real craft-log-run CLI against a real
// git repository, as the logger agent would run it. hasVerdict then reads the index line that filing produced.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './craft-log-run.mjs'
import { hasVerdict } from './push-hook.mjs'
import { repoKey } from './repo-key.mjs'
import { runEngine } from './engine-harness.mjs'

/** @type {string[]} */
const made = []
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

/** @param {string} prefix @returns {string} */
function tmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  made.push(dir)
  return dir
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

/** @param {string} repo */
function commitFix(repo) {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const fixed = 2\n')
  git(['commit', '-q', '-am', 'fix'], repo)
}

/**
 * What the logger agent runs: the `node "$CRAFT_LOGGER" <command> <flags>` line of the prompt, with the payload
 * the prompt carries on stdin, through the real CLI in `repo`.
 * @param {string} prompt @param {string} repo @param {string} store
 */
async function asLogger(prompt, repo, store) {
  // The session flag is shell-expanded from an unset variable here, so it expands to nothing.
  const line = (/node "\$CRAFT_LOGGER" (.*?)--project "\$PWD"/.exec(prompt)?.[1] ?? '').replace(/\$\{[^}]*\}/g, '')
  const argv = [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(m => m[1] != null ? m[1].replace(/'\\''/g, "'") : String(m[2]))
  const payload = prompt.split(/\n(?:PAYLOAD|RECORD):\n/)[1] ?? 'null'
  const r = await run([...argv, '--store', store, '--project', repo], {}, repo, () => payload)
  if (r.exitCode !== 0) return argv[0] === 'checkpoint' ? { runDir: '', error: r.stderr.join('\n') } : { ok: false, error: r.stderr.join('\n') }
  return argv[0] === 'checkpoint' ? { runDir: JSON.parse(String(r.stdout[0])).runDir, error: '' } : { ok: true }
}

/**
 * One clean adversarial-review of a one-commit repository; `beforeStart` runs between the scout and the start
 * checkpoint. @param {{ beforeStart?: (repo: string) => void }} [o]
 */
async function adversarialRun({ beforeStart = () => {} } = {}) {
  const repo = tmp('craft-adv-repo-')
  const store = tmp('craft-adv-store-')
  git(['init', '-q', '-b', 'feat/x'], repo)
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const fixed = 1\n')
  git(['add', 'app.ts'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  const first = git(['rev-parse', 'HEAD'], repo)
  const engine = await runEngine('adversarial-review', {
    args: {},
    script: {
      scout: () => ({ head: git(['rev-parse', '--short', 'HEAD'], repo), baseRef: 'main', sizeBucket: 'small', lenses: ['correctness'], changedFiles: ['app.ts'], notes: 'x' }),
      'index-warmup': { indexed: false, notes: 'x' },
      checkpoint: async (/** @type {{ prompt: string }} */ { prompt }) => {
        beforeStart(repo)
        return asLogger(prompt, repo, store)
      },
      'log-run': async (/** @type {{ prompt: string }} */ { prompt }) => asLogger(prompt, repo, store),
      review: { findings: [] },
      'coverage-critic': { findings: [] },
      '*': null,
    },
  })
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { repo, first, engine, lines }
}

test('a clean adversarial-review is a verdict on the commit it read, observed before any lens ran', async () => {
  const { repo, first, engine, lines } = await adversarialRun()
  const labels = engine.calls.map(c => c.label)
  const start = labels.indexOf('checkpoint:prep')
  assert.ok(start > labels.indexOf('scout'), labels.join(', '))
  assert.ok(labels.every((l, i) => !/^(lens|review|memory-recall)\b/.test(l) || i > start), `nothing reads the diff before the start checkpoint: ${labels.join(', ')}`)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.['name'], 'adversarial-review')
  assert.ok(!/INCOMPLETE/.test(String(lines[0]?.['verdict'])), String(lines[0]?.['verdict']))
  assert.deepEqual([lines[0]?.['reviewedHead'], lines[0]?.['reviewedDirty']], [first, false])
  assert.ok(hasVerdict(lines, repoKey(repo), first), 'the adversarial verdict silences the push line')
})

test('an adversarial-review whose head moved before its start checkpoint is no verdict on either commit', async () => {
  const { repo, first, lines } = await adversarialRun({ beforeStart: commitFix })
  const fix = git(['rev-parse', 'HEAD'], repo)
  assert.notEqual(fix, first)
  assert.deepEqual([lines[0]?.['reviewedHead'], lines[0]?.['reviewedDirty']], [null, null])
  assert.ok(!hasVerdict(lines, repoKey(repo), fix) && !hasVerdict(lines, repoKey(repo), first))
})
