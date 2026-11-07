// The lines a diff changed (lib/diff-lines.mjs, imported by src/review.js): the command the agent runs,
// the reading of its printed hunk lines, and whether a finding's line is among them (realm @nick/craft, node #277).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diffLinesPrompt, diffLinesScript, lineInDiff, readDiffLines } from './diff-lines.mjs'

test('script: headers-only git diff over the quoted files, one HUNK line per hunk', () => {
  const s = diffLinesScript("--merge-base 'main'", ['a.rs', "it's.rs"])
  assert.match(s, /^set -o pipefail; git diff -U0 --no-color --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ --merge-base 'main' -- 'a\.rs' 'it'\\''s\.rs' \| awk /)
  assert.match(diffLinesPrompt('HEAD', ['a.rs']), /exactly as written[\s\S]*git diff -U0 --no-color --no-ext-diff --src-prefix=a\/ --dst-prefix=b\/ HEAD -- 'a\.rs'/)
})

test('script: run against a real repository, it prints the new-side ranges the reader takes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-lines-'))
  try {
    const git = (/** @type {string[]} */ ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n4\n5\n6\n')
    git('add', '.'); git('commit', '-qm', 'base')
    fs.writeFileSync(path.join(dir, 'a.txt'), '1\nTWO\n3\n5\n6\n7\n8\n')
    const out = execFileSync('bash', ['-c', diffLinesScript('HEAD', ['a.txt'])], { cwd: dir, encoding: 'utf8' })
    assert.match(out, /\nHUNKS-END\n$/)
    const changed = readDiffLines({ lines: out.split('\n').filter(Boolean), reason: '' })
    assert.deepEqual(changed?.get('a.txt'), [[2, 2], [3, 4], [6, 7]])
    const failed = execFileSync('bash', ['-c', `${diffLinesScript("--merge-base 'no-such-ref'", ['a.txt'])} 2>/dev/null; true`], { cwd: dir, encoding: 'utf8' })
    assert.doesNotMatch(failed, /HUNKS-END/, 'a failed git prints no end line')
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) {
      git('config', String(k), String(v))
      const under = execFileSync('bash', ['-c', diffLinesScript('HEAD', ['a.txt'])], { cwd: dir, encoding: 'utf8' })
      assert.deepEqual(readDiffLines({ lines: under.split('\n').filter(Boolean) })?.get('a.txt'), [[2, 2], [3, 4], [6, 7]], `${k}=${v} changes nothing`)
      git('config', '--unset', String(k))
    }
    assert.equal(readDiffLines({ lines: failed.split('\n').filter(Boolean), reason: 'fatal' }), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('read: new-side ranges per file; a count of one is implied; a deletion marks its two neighbours', () => {
  const c = readDiffLines({ lines: ['HUNK\t+10,3\tb/src/a.rs', 'HUNK\t+20\tb/src/a.rs', 'HUNK\t+5,0\tb/src/b.rs', 'HUNKS-END'] })
  assert.deepEqual(c?.get('src/a.rs'), [[10, 12], [20, 20]])
  assert.deepEqual(c?.get('src/b.rs'), [[5, 6]])
})

test('read: a deleted file, a quoted path or a stray line is left out; no lines list is no answer', () => {
  const c = readDiffLines({ lines: ['HUNK\t+0,0\t/dev/null', 'HUNK\t+1,2\t"b/sp ace.rs"', 'noise', 7, 'HUNKS-END', ''] })
  assert.equal(c?.size, 0)
  assert.equal(readDiffLines(null), null)
  assert.equal(readDiffLines({ reason: 'git missing' }), null)
})

test('lineInDiff: inside, outside, a file the diff did not touch; null when it cannot be told', () => {
  const c = readDiffLines({ lines: ['HUNK\t+10,3\tb/a.rs', 'HUNKS-END'] })
  assert.equal(lineInDiff(c, 'a.rs', 10), true)
  assert.equal(lineInDiff(c, 'a.rs', 12), true)
  assert.equal(lineInDiff(c, 'a.rs', 13), false)
  assert.equal(lineInDiff(c, 'other.rs', 1), false)
  assert.equal(lineInDiff(null, 'a.rs', 10), null)
  assert.equal(lineInDiff(c, 'a.rs', 0), null)
  assert.equal(lineInDiff(c, '', 10), null)
})

test('read: no end line is no answer — an empty list with a reason, a list cut short, a failed command', () => {
  assert.equal(readDiffLines({ lines: [], reason: 'fatal: bad revision' }), null)
  assert.equal(readDiffLines({ lines: ['HUNK\t+10,3\tb/a.rs'], reason: '' }), null)
  assert.deepEqual(readDiffLines({ lines: ['HUNKS-END'], reason: '' }), new Map(), 'a diff that changed none of the files says so')
})
