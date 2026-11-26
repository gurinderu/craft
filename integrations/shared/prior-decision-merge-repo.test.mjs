// The scope-check line of a record naming no commit but a pull request (realm @nick/craft, node #682), run
// against the repository cli/crates/craft-review/src/memory/anchor/tests/repo/merge.rs builds: the base is the
// request's merge on the trunk, found by its subject along first parents; not found, the record's date.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { scopeCheckScript } from './prior-decision-scope.mjs'

const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) =>
  /** @type {any[]} */ (parsePriorDecisions(over.map(o => ({ title: 't', reason: 'r', ...o }))).decisions)

/** Runs git in `dir`, author and committer dated `date`. @param {string} dir @param {string[]} args @param {string} [date] */
const git = (dir, args, date = '2026-05-05T00:00:00+0000') =>
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

/** Commits `text` into `file` of `dir` at `date` with the subject `subject`. @param {string} dir @param {string} file @param {string} text @param {string} date @param {string} subject */
const landed = (dir, file, text, date, subject) => {
  writeFileSync(join(dir, file), text)
  git(dir, ['add', '.'], date)
  git(dir, ['commit', '-qm', subject], date)
  return git(dir, ['rev-parse', 'HEAD'], date)
}

/**
 * A trunk on origin `https://github.com/Owner/Repo.git`: pull request #7 adding src/m.rs merged by a merge
 * commit, a side branch's commit naming #7 merged after it, #8 adding src/s.rs squashed, #9 adding src/n.rs and the scope changed after its merge, then two near
 * misses of #7 — `(#77)` changing src/keep.rs, then `Merge pull request #70 from …` changing src/k2.rs — and HEAD
 * on a branch off it. @param {(dir: string, root: string) => void} body
 */
function inRepo(body) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-merge-'))
  try {
    const start = '2026-05-01T08:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], start)
    git(dir, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git'], start)
    mkdirSync(join(dir, 'src'))
    for (const f of ['keep', 'k2']) writeFileSync(join(dir, `src/${f}.rs`), '0\n')
    const root = landed(dir, 'src/a.rs', '0\n', start, 'src/a.rs')
    const opened = '2026-05-02T10:00:00+0000'
    git(dir, ['checkout', '-qb', 'feat7'], opened)
    landed(dir, 'src/m.rs', 'm\n', opened, 'feat: m')
    git(dir, ['checkout', '-q', 'main'], opened)
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from owner/feat7', 'feat7'], '2026-05-02T12:00:00+0000')
    // A side branch's commit naming #7, newer than its merge: off the first-parent line, never its merge.
    git(dir, ['checkout', '-qb', 'side'], '2026-05-02T13:00:00+0000')
    landed(dir, 'src/t.rs', 't\n', '2026-05-02T13:00:00+0000', 'docs: t (#7)')
    git(dir, ['checkout', '-q', 'main'], '2026-05-02T13:30:00+0000')
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #11 from owner/side', 'side'], '2026-05-02T13:30:00+0000')
    landed(dir, 'src/s.rs', 's\n', '2026-05-03T10:00:00+0000', 'feat: s (#8)')
    landed(dir, 'src/n.rs', 'n\n', '2026-05-03T11:00:00+0000', 'Merge pull request #9 from owner/feat9')
    landed(dir, 'src/n.rs', 'n2\n', '2026-05-04T10:00:00+0000', 'chore: n')
    landed(dir, 'src/keep.rs', '1\n', '2026-05-04T11:00:00+0000', 'fix: k (#77)')
    landed(dir, 'src/k2.rs', '1\n', '2026-05-04T12:00:00+0000', 'Merge pull request #70 from owner/x')
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    git(dir, ['checkout', '-qb', 'feat'])
    body(dir, root)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The lines `script` prints in `dir`. @param {string} script @param {string} dir */
const run = (script, dir) => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n')

/** @param {number} n */
const ours = n => `https://github.com/owner/repo/pull/${n}`
const other = 'https://github.com/someone/else/pull/7'

test('scope script: a record linking its pull request is diffed against that request merge on the trunk, else its date', () => {
  inRepo((dir, root) => {
    const ds = parsed(
      { id: "pr7's", scope: 'src/m.rs', when: '2026-05-02', links: [`${ours(7)}#r1`] },
      { id: 'day7', scope: 'src/m.rs', when: '2026-05-02' },
      { id: 'pr8', scope: 'src/s.rs', when: '2026-05-03', links: ['https://GitHub.com/Owner/Repo/pull/8/files'] },
      { id: 'pr9', scope: 'src/n.rs', when: '2026-05-03', links: [ours(9)] },
      { id: 'other', scope: 'src/m.rs', when: '2026-05-02', links: [other] },
      { id: 'unmerged', scope: 'src/a.rs', when: '2026-05-02', links: [ours(10)] },
      { id: 'unmerged-ahead', scope: 'src/a.rs', when: '2099-01-01', links: [ours(10)] },
      { id: 'unmerged-undated', scope: 'src/a.rs', links: [ours(10)] },
      { id: 'undated', scope: 'src/m.rs', links: [ours(7)] },
      { id: 'first-ours', scope: 'src/s.rs', links: [other, ours(8), ours(7)] },
      { id: 'near77', scope: 'src/keep.rs', links: [ours(7)] },
      { id: 'near70', scope: 'src/k2.rs', links: [ours(7)] },
      { id: 'side7', scope: 'src/t.rs', links: [ours(7)] },
      { id: 'by-commit', scope: 'src/m.rs', commit: root, links: [ours(7)] },
    )
    const seen = [
      "pr7's 0 merge 7",
      'day7 1',
      'pr8 0 merge 8',
      'pr9 1 merge 9',
      'other 1',
      'unmerged 0',
      'unmerged-ahead future',
      'unmerged-undated unmerged',
      'undated 0 merge 7',
      'first-ours 0 merge 8',
      'near77 1 merge 7',
      'near70 1 merge 7',
      'side7 1 merge 7',
      'by-commit 1',
    ]
    assert.deepEqual(run(scopeCheckScript(ds), dir), seen)
    // Each line stands alone, as the agent may run it.
    assert.deepEqual(run(scopeCheckScript(ds).split('\n')[9] ?? '', dir), ['first-ours 0 merge 8'])
    // The working tree counts as a change since the merge.
    writeFileSync(join(dir, 'src/s.rs'), 'edited\n')
    const changed = seen.map(l => l.replace(/^(pr8|first-ours) 0/, '$1 1'))
    assert.deepEqual(run(scopeCheckScript(ds), dir), changed)
  })
})

test('scope script: origin names this repository over https or ssh, any case, with .git or not', () => {
  inRepo(dir => {
    const ds = parsed({ id: 'pr7', scope: 'src/m.rs', when: '2026-05-02', links: [ours(7)] })
    for (const [url, line] of [
      ['https://github.com/owner/repo', 'pr7 0 merge 7'],
      ['git@github.com:owner/repo.git', 'pr7 0 merge 7'],
      ['git@GitHub.com:OWNER/repo', 'pr7 0 merge 7'],
      ['ssh://git@github.com/owner/repo.git', 'pr7 0 merge 7'],
      ['https://github.com/owner/repo2', 'pr7 1'],
      ['https://github.com/owner/repo/', 'pr7 1'],
      ['https://github.com/owner/repo.git.git', 'pr7 1'],
      ['https://gitlab.com/owner/repo', 'pr7 1'],
      ['owner/repo', 'pr7 1'],
    ]) {
      git(dir, ['remote', 'set-url', 'origin', String(url)])
      assert.deepEqual(run(scopeCheckScript(ds), dir), [line], String(url))
    }
  })
})

test('scope script: with no trunk a record linking its pull request falls back to its date, or with none is unmerged', () => {
  inRepo(dir => {
    const ds = parsed({ id: 'pr7', scope: 'src/m.rs', when: '2026-05-02', links: [ours(7)] }, { id: 'pr7-undated', scope: 'src/m.rs', links: [ours(7)] })
    git(dir, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
    git(dir, ['update-ref', '-d', 'refs/remotes/origin/main'])
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['pr7 no-trunk', 'pr7-undated unmerged'])
  })
})

test('scope script: a later commit citing a pull request is not its merge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-merge-order-'))
  try {
    const start = '2026-05-01T08:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], start)
    git(dir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], start)
    mkdirSync(join(dir, 'src'))
    landed(dir, 'src/a.rs', '0\n', start, 'src/a.rs')
    landed(dir, 'src/q.rs', 'q\n', '2026-05-02T10:00:00+0000', 'feat: q (#12)')
    landed(dir, 'src/q.rs', 'q2\n', '2026-05-03T10:00:00+0000', 'fix: q again (#12)')
    landed(dir, 'src/r.rs', 'r\n', '2026-05-02T11:00:00+0000', 'Merge pull request #13 from owner/r')
    const tip = landed(dir, 'src/r.rs', 'r2\n', '2026-05-03T11:00:00+0000', 'docs: r (#13)')
    git(dir, ['update-ref', 'refs/remotes/origin/main', tip])
    const ds = parsed(
      { id: 'pr12', scope: 'src/q.rs', links: ['https://github.com/owner/repo/pull/12'] },
      { id: 'pr13', scope: 'src/r.rs', links: ['https://github.com/owner/repo/pull/13'] },
    )
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['pr12 1 merge 12', 'pr13 1 merge 13'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
