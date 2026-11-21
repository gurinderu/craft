// The shipped Node entries feed knip's production run and dependency-cruiser's reach rule: an entry
// that names no file, or a list that lost one, would quietly narrow what both configs hold.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_NODE_ENTRIES } from './shipped-entries.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('the shipped entries are the run-record CLI, the run-store reader, the PR-rejection reader, the recurrence reader, the finding-post request builder, the SessionStart hook, the reviewer-dispatch hook, the engine source-map reader, the units CLI, the craft binary fetcher, the run-record adapter that binary runs, the pi extension, the external-findings matcher, the OpenCode plugin and its TUI footer entry, each a real file', () => {
  assert.deepEqual([...SHIPPED_NODE_ENTRIES].sort(), [
    'integrations/opencode/plugin/index.ts',
    'integrations/opencode/plugin/tui/tui.mjs',
    'integrations/pi/pi-extension.mjs',
    'integrations/shared/analyze-runs.mjs',
    'integrations/shared/craft-bin.mjs',
    'integrations/shared/craft-externals.mjs',
    'integrations/shared/craft-log-run.mjs',
    'integrations/shared/craft-units.mjs',
    'integrations/shared/engine-source-map.mjs',
    'integrations/shared/finding-post.mjs',
    'integrations/shared/match-external-findings-cli.mjs',
    'integrations/shared/pr-rejections.mjs',
    'integrations/shared/recurring-findings.mjs',
    'integrations/shared/unit-boundary.mjs',
  ])
  for (const entry of SHIPPED_NODE_ENTRIES) assert.ok(fs.statSync(path.join(root, entry)).isFile(), entry)
})
