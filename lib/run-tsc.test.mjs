// runTsc reports what the compiler did, whatever it did: each test plants a stand-in compiler at the
// pinned entry of a scratch root, so every exit path is driven directly rather than through a real tsc.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadTypescript, runTsc, tscEntry, tscMissingMessage } from './run-tsc.mjs'

/**
 * A scratch root whose tsc entry is `body`, a Node script; null `body` plants no entry at all.
 * @param {string | null} body @returns {string}
 */
function rootWith(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-runtsc-'))
  if (body != null) {
    fs.mkdirSync(path.dirname(tscEntry(root)), { recursive: true })
    fs.writeFileSync(tscEntry(root), body)
  }
  return root
}

/** @param {string | null} body @param {(root: string) => void} check */
function withRoot(body, check) {
  const root = rootWith(body)
  try { check(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('no entry file: missing, naming the entry, and loadTypescript agrees there is none', () => {
  withRoot(null, root => {
    assert.deepEqual(runTsc(root, []), { missing: true, entry: tscEntry(root) })
    assert.equal(loadTypescript(root), null)
    assert.equal(tscMissingMessage(root), `tsc is not installed at ${path.join('opencode', 'plugin', 'node_modules', 'typescript', 'bin', 'tsc')} — run npm ci --prefix opencode/plugin`)
  })
})

test('a clean exit carries stdout as text, the arguments passed through, and nothing else', () => {
  withRoot('process.stdout.write(JSON.stringify(process.argv.slice(2)))', root => {
    assert.deepEqual(runTsc(root, ['-p', 'x.json']), { missing: false, status: 0, stdout: '["-p","x.json"]', stderr: '', overflow: false })
  })
})

test('the compiler reads no stdin: an inherited one would block or feed it', () => {
  withRoot("const fs = require('node:fs'); let n; try { n = fs.readFileSync(0).length } catch { n = -1 } process.stdout.write(String(n))", root => {
    assert.deepEqual(runTsc(root, []), { missing: false, status: 0, stdout: '0', stderr: '', overflow: false })
  })
})

test('an output of a few megabytes is read whole, not cut off as an overflow', () => {
  withRoot("process.stdout.write('x'.repeat(2 * 1024 * 1024))", root => {
    const r = runTsc(root, [])
    assert.ok(!r.missing)
    assert.equal(r.status, 0)
    assert.equal(r.stdout.length, 2 * 1024 * 1024)
    assert.equal(r.overflow, false)
  })
})

test('a failing exit carries its status, stdout and stderr as tsc printed them', () => {
  withRoot("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 2", root => {
    assert.deepEqual(runTsc(root, []), { missing: false, status: 2, stdout: 'out', stderr: 'err', overflow: false })
  })
})

test('a failure that printed only to stdout has an empty stderr, not the launcher\'s message', () => {
  withRoot("process.stdout.write('a.ts(1,1): error TS1'); process.exitCode = 1", root => {
    assert.deepEqual(runTsc(root, []), { missing: false, status: 1, stdout: 'a.ts(1,1): error TS1', stderr: '', overflow: false })
  })
})

test('a silent failure says why in stderr, from the launcher', () => {
  withRoot('process.exitCode = 3', root => {
    const r = runTsc(root, [])
    assert.ok(!r.missing)
    assert.equal(r.status, 3)
    assert.equal(r.stdout, '')
    // The error's message itself, not the error stringified (`Error: Command failed…`).
    assert.match(r.stderr, /^Command failed/)
  })
})

test('a compiler killed by a signal has no exit status, and reads as status 1', () => {
  withRoot("process.kill(process.pid, 'SIGKILL')", root => {
    const r = runTsc(root, [])
    assert.ok(!r.missing)
    assert.equal(r.status, 1)
    assert.equal(r.overflow, false)
  })
})

test('an output past the buffer is an overflow, not a pass', () => {
  withRoot("process.stdout.write('x'.repeat(65 * 1024 * 1024))", root => {
    const r = runTsc(root, [])
    assert.ok(!r.missing)
    assert.equal(r.overflow, true)
    assert.notEqual(r.status, 0)
  })
})
