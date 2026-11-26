// The scope-check line of a dated record linking its pull request (realm @nick/craft, node #682), run against the
// repository cli/crates/craft-review/src/memory/anchor/tests/repo/between.rs builds: unchanged only when its scope
// also did not change on the trunk between its decision date and the merge.
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
 * anywhere; #8 squashed on the 2nd changing src/w.rs; then #7, opened before #8 landed and changing src/p.rs,
 * merged after it by a merge commit. @param {(dir: string) => void} body
 */
function inRepo(body) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-between-'))
  try {
    const start = '2026-05-01T08:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], start)
    git(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], start)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/w.rs'), 'w\n')
    landed(dir, 'src/p.rs', 'p\n', start, 'root')
    const opened = '2026-05-02T08:00:00+0000'
    git(dir, ['checkout', '-qb', 'feat7'], opened)
    landed(dir, 'src/p.rs', 'p7\n', opened, 'feat: p')
    git(dir, ['checkout', '-q', 'main'], opened)
    landed(dir, 'src/w.rs', 'w8\n', '2026-05-02T09:00:00+0000', 'fix: w (#8)')
    const merged = '2026-05-02T12:00:00+0000'
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from owner/feat7', 'feat7'], merged)
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], merged)
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The lines `script` prints in `dir`. @param {string} script @param {string} dir */
const run = (script, dir) => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n')

test('scope script: a dated record linking its pull request is changed when the trunk changed its scope between its date and the merge', () => {
  inRepo(dir => {
    const links = ['https://github.com/owner/repo/pull/7']
    const ds = /** @type {any[]} */ (
      parsePriorDecisions(
        [
          { id: 'w-dated', scope: 'src/w.rs', when: '2026-05-02' },
          { id: 'p-dated', scope: 'src/p.rs', when: '2026-05-02' },
          { id: 'w-undated', scope: 'src/w.rs' },
          { id: 'w-after', scope: 'src/w.rs', when: '2026-05-10' },
          { id: 'w-before-root', scope: 'src/w.rs', when: '2026-04-01' },
          { id: 'w-ahead', scope: 'src/w.rs', when: '2099-01-01' },
        ].map(o => ({ title: 't', reason: 'r', links, ...o })),
      ).decisions
    )
    const seen = ['w-dated 1 merge 7 between', 'p-dated 0 merge 7', 'w-undated 0 merge 7', 'w-after 0 merge 7', 'w-before-root 0 merge 7', 'w-ahead 0 merge 7']
    assert.deepEqual(run(scopeCheckScript(ds), dir), seen)
    // Changed since the merge too: said as a change since the merge, not before it.
    writeFileSync(join(dir, 'src/w.rs'), 'edited\n')
    assert.deepEqual(
      run(scopeCheckScript(ds), dir),
      seen.map(l => (l.startsWith('p-') ? l : l.replace(/ 0 merge 7$| 1 merge 7 between$/, ' 1 merge 7'))),
    )
  })
})
