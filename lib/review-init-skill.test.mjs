// The command the review-init skill (skills/review-init/SKILL.md) gives for handing the recalled `external` records
// to `craft init --memory-externals -`, run as written with a stand-in binary: the records reach its stdin unchanged
// whatever quotes, dollars or backslashes their text carries.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = fs.readFileSync(path.join(ROOT, 'skills/review-init/SKILL.md'), 'utf8')
const RECORDS_SLOT = '<the recalled records as one JSON list, on one line>'

/** The propose command of the skill's second step: from the binary's call to the heredoc's end. */
function proposeCommand() {
  const lines = SKILL.split('\n')
  const start = lines.findIndex(l => l.startsWith('"$CRAFT_BIN" init --propose'))
  assert.ok(start >= 0, 'the skill runs `craft init --propose`')
  const eof = /<<'([A-Z_]+)'$/.exec(lines[start] ?? '')?.[1]
  assert.ok(eof, 'the records go in through a quoted heredoc')
  const end = lines.indexOf(eof, start + 1)
  assert.ok(end > start, 'the heredoc is closed')
  return lines.slice(start, end + 1).join('\n')
}

test('the recalled records reach craft init unchanged, a quote in them included', () => {
  const records = JSON.stringify([{ system: "kube-ovn's API", repo: 'https://example.com/$HOME/`id`', version: 'v1 \\ "x"' }])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-init-'))
  try {
    const bin = path.join(dir, 'craft')
    fs.writeFileSync(bin, '#!/bin/sh\ncat\n', { mode: 0o755 })
    const command = proposeCommand().replace(RECORDS_SLOT, records).replaceAll("<this skill's base directory>", dir)
    const out = execFileSync('sh', ['-c', command], { cwd: ROOT, env: { ...process.env, CRAFT_BIN: bin }, encoding: 'utf8' })
    assert.equal(out, `${records}\n`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(!SKILL.includes("printf '%s' '"), 'no single-quoted printf of the records is left')
})
