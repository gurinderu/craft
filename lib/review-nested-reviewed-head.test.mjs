// A review whose diff no profile covers goes wholly to the nested adversarial-review (lib/review-nested.mjs), and its
// own record is still a verdict on the commit the run started on (realm @nick/craft, node #301): the review engine runs
// in the harness, each logger dispatch it makes is carried out by the real craft-log-run CLI in a real git repository,
// and the push hook's hasVerdict reads the index line that filing produced.
import { afterAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asLogger } from './logger-replay.mjs'
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

/**
 * One review of a JavaScript-only commit, its nested run answering `nested`; `whileNested` runs while the nested run
 * reads the tree. @param {{ whileNested?: (repo: string) => void }} [o]
 */
async function noProfileRun({ whileNested = () => {} } = {}) {
  const repo = tmp('craft-noprofile-repo-')
  const store = tmp('craft-noprofile-store-')
  git(['init', '-q', '-b', 'feat/x'], repo)
  fs.mkdirSync(path.join(repo, 'web'))
  fs.writeFileSync(path.join(repo, 'web/app.js'), 'export const a = 1\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'a'], repo)
  const first = git(['rev-parse', 'HEAD'], repo)
  /** @param {{ prompt: string }} call */
  const logger = ({ prompt }) => asLogger(prompt, repo, store)
  const engine = await runEngine('review', {
    script: {
      detect: () => ({ baseRef: 'main', files: ['web/app.js'], spec: '', branch: 'feat/x', head: git(['rev-parse', '--short', 'HEAD'], repo) }),
      'prior-round': { found: false, round: 0, head: '', ledger: [], ledgerCount: 0, priorFindings: 0, reason: 'none' },
      checkpoint: logger,
      'log-run': logger,
      workflow: () => {
        whileNested(repo)
        return { verdict: 'Approve', confirmed: [], suspected: [], notRun: [] }
      },
      '*': null,
    },
  })
  const lines = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { repo, first, engine, lines }
}

test('a review no profile covers files its verdict on the commit it started on, and that verdict silences the push line', async () => {
  const { repo, first, engine, lines } = await noProfileRun()
  assert.equal(lines.length, 1)
  assert.deepEqual([lines[0]?.['name'], lines[0]?.['nested'], lines[0]?.['verdict']], ['review', false, 'Approve'])
  assert.deepEqual([lines[0]?.['reviewedHead'], lines[0]?.['reviewedDirty']], [first, false])
  assert.ok(hasVerdict(lines, repoKey(repo), first), 'the no-profile review verdict silences the push line')
  const labels = engine.calls.map(c => c.label)
  assert.ok(labels.indexOf('checkpoint:nested-route') >= 0 && labels.indexOf('checkpoint:nested-route') < labels.indexOf('workflow'), `the start checkpoint lands before the nested run: ${labels.join(', ')}`)
})

test('a commit made while the nested run reads the tree is not taken as reviewed', async () => {
  const { repo, first, lines } = await noProfileRun({
    whileNested: dir => {
      fs.writeFileSync(path.join(dir, 'web/app.js'), 'export const a = 2\n')
      git(['commit', '-q', '-am', 'fix'], dir)
    },
  })
  const fix = git(['rev-parse', 'HEAD'], repo)
  assert.notEqual(fix, first)
  assert.equal(lines[0]?.['reviewedHead'], first)
  assert.ok(!hasVerdict(lines, repoKey(repo), fix), 'the fix committed under the review was never reviewed')
})
