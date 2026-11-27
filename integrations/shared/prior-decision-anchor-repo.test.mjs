// The scope-check line of a record anchored by its date (realm @nick/craft, node #676), run against a
// repository whose commits straddle the start of the day: the base is the trunk's, along first parents,
// before the day began anywhere — the repository cli/crates/craft-review/src/memory/anchor/tests/repo.rs builds.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePriorDecisions } from './prior-decisions.mjs'
import { scopeCheckScript } from './prior-decision-scope.mjs'

const parsed = (/** @type {Array<Record<string, unknown>>} */ ...over) =>
  /** @type {any[]} */ (parsePriorDecisions(over.map(o => ({ title: 't', reason: 'r', scope: 'src/a.rs', when: '2026-05-02', ...o }))).decisions)

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
  }).trim()

/** Commits `text` into `file` of `dir` at `date`. @param {string} dir @param {string} file @param {string} text @param {string} date */
const commit = (dir, file, text, date) => {
  writeFileSync(join(dir, file), text)
  git(dir, ['add', '.'], date)
  git(dir, ['commit', '-qm', file], date)
  return git(dir, ['rev-parse', 'HEAD'], date)
}

/**
 * A trunk whose last commits straddle the start of 2026-05-02 anywhere (2026-05-01 10:00 UTC), a side
 * branch dated before that day merged into it after, and HEAD on a branch off the trunk with a backdated
 * commit — origin/HEAD naming the trunk unless `trunk` is false. @param {boolean} trunk @param {(dir: string) => void} body
 */
function inRepo(trunk, body) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-anchor-'))
  try {
    git(dir, ['init', '-q', '-b', 'main'], '2026-04-30T12:00:00+0000')
    mkdirSync(join(dir, 'src'))
    for (const f of ['a', 'b', 'd']) writeFileSync(join(dir, `src/${f}.rs`), '0\n')
    const first = commit(dir, 'src/b.rs', '0\n', '2026-04-30T12:00:00+0000')
    // 09:00 UTC on the 1st: before the 2nd began anywhere, so the base of a record of the 2nd.
    commit(dir, 'src/b.rs', '1\n', '2026-05-01T09:00:00+0000')
    git(dir, ['checkout', '-qb', 'side', first], '2026-05-01T09:30:00+0000')
    // Dated before the 2nd, merged after it: never the base.
    commit(dir, 'src/d.rs', 'side\n', '2026-05-01T09:30:00+0000')
    git(dir, ['checkout', '-q', 'main'], '2026-05-01T15:00:00+0000')
    // 15:00 UTC on the 1st: the 2nd had begun at +14:00, so after a record of the 2nd.
    commit(dir, 'src/a.rs', '1\n', '2026-05-01T15:00:00+0000')
    const merged = '2026-05-03T12:00:00+0000'
    git(dir, ['merge', '-q', '--no-ff', '-m', 'side', 'side'], merged)
    if (trunk) {
      git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], merged)
      git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], merged)
    }
    git(dir, ['checkout', '-qb', 'feat'], merged)
    // The change's own commit, backdated: it counts as after every record all the same.
    commit(dir, 'src/c.rs', 'feat\n', '2026-04-01T00:00:00+0000')
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The lines `script` prints in `dir`. @param {string} script @param {string} dir */
const run = (script, dir) => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' }).trim().split('\n')

test('scope script: a dated record is diffed against the trunk before its day began anywhere, along first parents', () => {
  inRepo(true, dir => {
    const ds = parsed(
      { id: "a-2nd's" },
      { id: 'b-2nd', scope: 'src/b.rs' },
      { id: 'c-2nd', scope: 'src/c.rs' },
      { id: 'd-2nd', scope: 'src/d.rs' },
      { id: 'b-zoned-2nd', scope: 'src/b.rs', when: '2026-05-01T23:30:00-02:00' },
      { id: 'b-zoned-1st', scope: 'src/b.rs', when: '2026-05-02T01:00:00+05:00' },
      { id: 'a-4th', when: '2026-05-04' },
      { id: 'a-ahead', when: '2099-01-01' },
    )
    const script = scopeCheckScript(ds)
    assert.equal(
      script.split('\n')[0],
      `(top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] && cd "$top" 2>/dev/null || { echo 'a-2nd'\\''s' $?; exit; }; ` +
        `if [ '20260502' -gt "$(date -u +%F | tr -d -)" ]; then echo 'a-2nd'\\''s' future; ` +
        `elif ! t=$(for r in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do [ -n "$r" ] && git rev-parse -q --verify "$r^{commit}" >/dev/null && echo "$r" && break; done | grep .); then echo 'a-2nd'\\''s' no-trunk; ` +
        `elif ! b=$(git rev-list -1 --first-parent '--before=2026-05-02 00:00:00 +1400' "$t" 2>/dev/null); then echo 'a-2nd'\\''s' unreadable; ` +
        `elif [ -n "$b" ]; then git diff --quiet "$b" -- 'src/a.rs'; echo 'a-2nd'\\''s' $?; else echo 'a-2nd'\\''s' missing; fi)`,
    )
    const seen = ["a-2nd's 1", 'b-2nd 0', 'c-2nd 1', 'd-2nd 1', 'b-zoned-2nd 0', 'b-zoned-1st missing', 'a-4th 0', 'a-ahead future']
    assert.deepEqual(run(script, dir), seen)
    writeFileSync(join(dir, 'src/b.rs'), '2\n')
    const changed = seen.map(l => l.replace(/^(b-2nd|b-zoned-2nd) 0$/, '$1 1'))
    assert.deepEqual(run(script, dir), changed, 'the working tree counts as a change')
  })
})

test('scope script: with no origin/HEAD a dated record prints no-trunk, a commit record is still checked', () => {
  inRepo(false, dir => {
    const first = git(dir, ['rev-list', '--max-parents=0', 'HEAD'], '2026-05-04T00:00:00+0000')
    const ds = parsed({ id: 'dated', scope: 'src/b.rs' }, { id: 'by-commit', commit: first })
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['dated no-trunk', 'by-commit 1'])
  })
})

test('scope script: with no origin/HEAD, or one naming no commit, the trunk is origin/main', () => {
  inRepo(false, dir => {
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'main'], '2026-05-04T00:00:00+0000')
    const ds = parsed({ id: 'b-2nd', scope: 'src/b.rs', when: '2026-05-02' })
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['b-2nd 0'])
    // The default branch renamed and pruned: origin/HEAD dangles, origin/main still resolves.
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone'], '2026-05-04T00:00:00+0000')
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['b-2nd 0'])
  })
})

test('scope script: a record dated today is not in the future', () => {
  inRepo(true, dir => {
    const today = new Date().toISOString().slice(0, 10)
    assert.deepEqual(run(scopeCheckScript(parsed({ id: 'a-today', when: today })), dir), ['a-today 0'])
  })
})

test('scope script: the trunk is walked from its tip, not from where HEAD forks from it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-anchor-'))
  try {
    const start = '2026-04-30T12:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], start)
    mkdirSync(join(dir, 'src'))
    for (const f of ['s', 't', 'u']) writeFileSync(join(dir, `src/${f}.rs`), '0\n')
    const root = commit(dir, 'src/u.rs', '0\n', start)
    git(dir, ['checkout', '-qb', 'side', root], start)
    // HEAD forks from this side commit, dated before the 2nd and merged into the trunk after it.
    const side = commit(dir, 'src/s.rs', 'side\n', '2026-05-01T08:00:00+0000')
    git(dir, ['checkout', '-q', 'main'], start)
    commit(dir, 'src/t.rs', '1\n', '2026-05-01T09:00:00+0000')
    const merged = '2026-05-03T12:00:00+0000'
    git(dir, ['merge', '-q', '--no-ff', '-m', 'side', 'side'], merged)
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], merged)
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], merged)
    git(dir, ['checkout', '-qb', 'feat', side], merged)
    commit(dir, 'src/f.rs', 'feat\n', '2026-05-03T13:00:00+0000')
    const ds = parsed({ id: 's-2nd', scope: 'src/s.rs' }, { id: 't-2nd', scope: 'src/t.rs' }, { id: 'u-2nd', scope: 'src/u.rs' })
    // From the fork (the side commit) or from HEAD, s.rs and t.rs would read unchanged.
    assert.deepEqual(run(scopeCheckScript(ds), dir), ['s-2nd 1', 't-2nd 1', 'u-2nd 0'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope script: a trunk git cannot walk prints unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'craft-anchor-'))
  try {
    const date = '2026-04-30T12:00:00+0000'
    git(dir, ['init', '-q', '-b', 'main'], date)
    const root = commit(dir, 'a.rs', '0\n', date)
    commit(dir, 'a.rs', '1\n', '2026-05-01T09:00:00+0000')
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], date)
    git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], date)
    // The root's object gone: the fork resolves, the walk back to before the root fails.
    unlinkSync(join(dir, '.git/objects', root.slice(0, 2), root.slice(2)))
    assert.deepEqual(run(scopeCheckScript(parsed({ id: 'early', scope: 'a.rs', when: '2026-04-29' })), dir), ['early unreadable'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
