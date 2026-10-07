// The shipped Node entries feed knip's production run and dependency-cruiser's reach rule: an entry
// that names no file, or a list that lost one, would quietly narrow what both configs hold.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_NODE_ENTRIES } from './shipped-entries.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the shipped entries are the run-record CLI, the run-store reader and the OpenCode plugin, each a real file', () => {
  assert.deepEqual([...SHIPPED_NODE_ENTRIES].sort(), ['lib/analyze-runs.mjs', 'lib/craft-log-run.mjs', 'lib/pr-rejections.mjs', 'opencode/plugin/index.ts'])
  for (const entry of SHIPPED_NODE_ENTRIES) assert.ok(fs.statSync(path.join(root, entry)).isFile(), entry)
})
