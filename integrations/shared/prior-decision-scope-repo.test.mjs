// The scope-check lines run where the agent's shell happens to be: a scope is a path from the repository's
// top level, so a line run from a subdirectory, or outside any repository, must not read a changed scope
// as unchanged.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { scopeCheckScript } from './prior-decision-scope.mjs'

const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) =>
  /** @type {any[]} */ (parsePriorDecisions(over.map(o => ({ title: 't', reason: 'r', scope: 'src/a.rs', ...o }))).decisions)

const date = '2026-05-01T09:00:00+0000'
/** Runs git in `dir`. @param {string} dir @param {string[]} args */
const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim()

/**
 * The lines `script` prints with `cwd` as the shell's directory; git looks for a repository no higher than
 * the temporary directory. @param {string} script @param {string} cwd
 */
const run = (script, cwd) =>
  execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })
    .trim()
    .split('\n')

/** A temporary directory, removed after `body`. @param {(dir: string) => void} body */
function inDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-scope-'))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('scope script: run from a subdirectory, a changed scope reads changed — by commit and by date', () => {
  inDir(dir => {
    git(dir, ['init', '-q', '-b', 'main'])
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'src/a.rs'), '0\n')
    writeFileSync(join(dir, 'docs/x.md'), '0\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-qm', 'one'])
    const head = git(dir, ['rev-parse', 'HEAD'])
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    writeFileSync(join(dir, 'src/a.rs'), '1\n')
    const ds = parsed({ id: 'by-commit', commit: head }, { id: 'by-date', when: '2026-05-02' }, { id: 'other', scope: 'docs/x.md', commit: head })
    for (const cwd of [dir, join(dir, 'src'), join(dir, 'docs')]) assert.deepEqual(run(scopeCheckScript(ds), cwd), ['by-commit 1', 'by-date 1', 'other 0'], cwd)
  })
})

test('scope script: with no repository top level to run from, each line prints a non-zero status, never 0', () => {
  inDir(dir => {
    const ds = parsed({ id: 'by-commit', commit: 'abc1234' }, { id: 'by-date', when: '2026-05-02' })
    const seen = run(scopeCheckScript(ds), dir)
    assert.equal(seen.length, 2)
    for (const [i, l] of seen.entries()) assert.match(l, new RegExp(`^${ds[i].id} [1-9][0-9]*$`))
  })
})
