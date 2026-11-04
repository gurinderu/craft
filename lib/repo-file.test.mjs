// A repository file read only inside the repository (lib/repo-file.mjs, realm @nick/craft, nodes #430 and #435).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inside, readRepoFile } from './repo-file.mjs'

test('a file inside is read; outside, through a symlink out, missing, a directory or over the bound is refused', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-file-')))
  try {
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(path.join(repo, 'd'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'd', 'a.yaml'), 'x: 1\n')
    fs.writeFileSync(path.join(tmp, 'secret'), 's')
    fs.symlinkSync(path.join(tmp, 'secret'), path.join(repo, 'link'))
    const bound = { max: 10, label: 'f' }
    assert.equal(readRepoFile(repo, 'd/a.yaml', bound), 'x: 1\n')
    assert.throws(() => readRepoFile(repo, '../secret', bound), /f resolves outside the repository/)
    assert.throws(() => readRepoFile(repo, 'link', bound), /f resolves outside the repository/)
    assert.throws(() => readRepoFile(repo, 'nope', bound), /f nope not found/)
    assert.throws(() => readRepoFile(repo, 'd', bound), /f d is not a file of at most 10 bytes/)
    assert.throws(() => readRepoFile(repo, 'd/a.yaml', { max: 2, label: 'f' }), /at most 2 bytes/)
    assert.ok(inside('/r', '/r') && inside('/r', '/r/x') && !inside('/r', '/rx'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
