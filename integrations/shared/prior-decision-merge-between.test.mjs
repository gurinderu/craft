// The scope-check line of a record linking its pull request (realm @nick/craft, node #682), run against the
// repositories cli/crates/craft-review/src/memory/anchor/tests/repo/between.rs builds: unchanged only when its scope
// also did not change on the trunk outside the pull request before the merge — where the request's branch lacked
// it, or after the record's decision date.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { scopeCheckScript } from './prior-decision-scope.mjs'

/** Runs git in `dir`, author and committer dated `date`. @param {string} dir @param {string[]} args @param {string} date */
const git = (dir, args, date) =>
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
  })

/** Commits `text` into `file` of `dir` at `date` with the subject `subject`. @param {string} dir @param {string} file @param {string} text @param {string} date @param {string} subject */
const landed = (dir, file, text, date, subject) => {
  writeFileSync(join(dir, file), text)
  git(dir, ['add', '.'], date)
  git(dir, ['commit', '-qm', subject], date)
}

/**
 * A trunk on origin `git@github.com:owner/repo.git`: its root on 2026-05-01 08:00 UTC, before 2026-05-02 began
 * anywhere; #7 opened off it at 09:00 changing src/p.rs; #8 squashed on 2026-05-02 09:00 UTC, before 2026-05-03
 * began anywhere, changing src/a.rs; then #7 landing on 2026-05-04 as `how` says: `stale`, a merge commit of its
 * branch as it was opened; `rebased`, a merge commit of its branch rebased onto #8; `squashed`, one parent.
 * @param {'stale' | 'rebased' | 'squashed'} how @param {(dir: string) => void} body
 */
function inRepo(how, body) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-between-'))
  try {
    const start = '2026-05-01T08:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], start)
    git(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], start)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/a.rs'), 'a\n')
    landed(dir, 'src/p.rs', 'p\n', start, 'root')
    const opened = '2026-05-01T09:00:00+0000'
    git(dir, ['checkout', '-qb', 'feat7'], opened)
    landed(dir, 'src/p.rs', 'p7\n', opened, 'feat: p')
    git(dir, ['checkout', '-q', 'main'], opened)
    landed(dir, 'src/a.rs', 'a8\n', '2026-05-02T09:00:00+0000', 'fix: a (#8)')
    const merged = '2026-05-04T12:00:00+0000'
    if (how === 'rebased') {
      const rebased = '2026-05-02T10:00:00+0000'
      git(dir, ['checkout', '-q', 'feat7'], rebased)
      git(dir, ['rebase', '-q', 'main'], rebased)
      git(dir, ['checkout', '-q', 'main'], rebased)
    }
    if (how === 'squashed') {
      git(dir, ['merge', '-q', '--squash', 'feat7'], merged)
      git(dir, ['commit', '-qm', 'feat: p (#7)'], merged)
    } else git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from owner/feat7', 'feat7'], merged)
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], merged)
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The lines `script` prints in `dir`, `env` its environment. @param {string} script @param {string} dir @param {NodeJS.ProcessEnv} [env] */
const run = (script, dir, env = process.env) => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8', env }).trim().split('\n')

const links = ['https://github.com/owner/repo/pull/7']

/** The records, a-ahead right after a-early, whose date's base a line run after it must not keep. */
const records = () =>
  /** @type {any[]} */ (
    parsePriorDecisions(
      [
        { id: 'a-early', scope: 'src/a.rs', when: '2026-05-02' },
        { id: 'a-ahead', scope: 'src/a.rs', when: '2099-01-01' },
        { id: 'a-dated', scope: 'src/a.rs', when: '2026-05-03' },
        { id: 'a-undated', scope: 'src/a.rs' },
        { id: 'p-dated', scope: 'src/p.rs', when: '2026-05-03' },
        { id: 'p-after', scope: 'src/p.rs', when: '2026-05-10' },
        { id: 'a-before-root', scope: 'src/a.rs', when: '2026-04-01' },
      ].map(o => ({ title: 't', reason: 'r', links, ...o })),
    ).decisions
  )

/** What the lines print when only `outside` are changed outside the pull request. @param {string[]} outside */
const seen = outside =>
  records().map(d => (d.id === 'a-before-root' ? `${d.id} missing` : outside.includes(d.id) ? `${d.id} 1 merge 7 between` : `${d.id} 0 merge 7`))

test('scope script: a stale branch’s merge is changed when the trunk changed its scope where the branch lacked it, with or without a date', () => {
  inRepo('stale', dir => {
    assert.deepEqual(run(scopeCheckScript(records()), dir), seen(['a-early', 'a-ahead', 'a-dated', 'a-undated']))
  })
})

test('scope script: a rebased branch’s merge and a squash are changed only for a trunk change after the decision date', () => {
  for (const how of /** @type {const} */ (['rebased', 'squashed']))
    inRepo(how, dir => {
      assert.deepEqual(run(scopeCheckScript(records()), dir), seen(['a-early']), how)
    })
})

test('scope script: a scope changed since the merge too is said changed since it', () => {
  inRepo('stale', dir => {
    writeFileSync(join(dir, 'src/a.rs'), 'edited\n')
    const out = seen([]).map(l => (l.startsWith('a-') && !l.endsWith('missing') ? l.replace(' 0 merge 7', ' 1 merge 7') : l))
    assert.deepEqual(run(scopeCheckScript(records()), dir), out)
  })
})

/**
 * A directory holding a `git` that exits 1 when its arguments match the shell pattern `pattern`, else runs git.
 * @param {string} pattern @param {(env: NodeJS.ProcessEnv) => void} body
 */
function failingGit(pattern, body) {
  const shim = mkdtempSync(join(tmpdir(), 'craft-git-shim-'))
  try {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase "$*" in ${pattern}) exit 1;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 })
    body({ ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}` })
  } finally {
    rmSync(shim, { recursive: true, force: true })
  }
}

test('scope script: git failing to list the trunk before a merged record’s date raises it unreadable, as the date’s line does', () => {
  inRepo('stale', dir => {
    failingGit('rev-list*', env => {
      const ds = /** @type {any[]} */ (
        parsePriorDecisions(
          [
            { id: 'p-dated', scope: 'src/p.rs', when: '2026-05-02', links },
            { id: 'p-undated', scope: 'src/p.rs', links },
            { id: 'p-ahead', scope: 'src/p.rs', when: '2099-01-01', links },
            { id: 'day', scope: 'src/p.rs', when: '2026-05-02' },
          ].map(o => ({ title: 't', reason: 'r', ...o })),
        ).decisions
      )
      assert.deepEqual(run(scopeCheckScript(ds), dir, env), ['p-dated unreadable', 'p-undated 0 merge 7', 'p-ahead 0 merge 7', 'day unreadable'])
    })
  })
})

test('scope script: git failing to read a merge’s parents counts as a change outside the pull request', () => {
  inRepo('stale', dir => {
    failingGit("*'^@'*", env => {
      const ds = records().filter(d => d.id.startsWith('p-'))
      assert.deepEqual(run(scopeCheckScript(ds), dir, env), ['p-dated 1 merge 7 between', 'p-after 1 merge 7 between'])
    })
  })
})
